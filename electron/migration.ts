// ============================================================================
// vellum - migration.ts (F0)
// ============================================================================
// atallas a haveromrol a vellumra.
//
// A LEGFONTOSABB SZABALY: a haverom mappat SOHA nem toroljuk.
// visszaut kell. ha barmi elromlik, a felhasznalo vissza tud allni a regi
// appra, es nem veszit adatot.
//
// a migracio egyszer fut le, az elso inditaskor. utana egy marker fajl
// jelzi, hogy mar megtortent.
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tr } from './i18n';

import { FILES, LEGACY_APP_NAME, APP_NAME, DEFAULT_SETTINGS } from './shared';
import type { VellumSettings } from './shared';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface MigrationResult {
  /** tortent-e egyaltalan migracio */
  migrated: boolean;
  /** a beallitasok atkerultek-e */
  settingsMigrated: boolean;
  /** a memoria atkerult-e (meg nyers md formaban) */
  memoryFound: boolean;
  /** ha volt hiba, de a migracio nem allt le miatta */
  warnings: string[];
  error?: string;
}

interface MigrationMarker {
  from: string;
  at: number;
  version: number;
}

// ----------------------------------------------------------------------------
// utvonalak
// ----------------------------------------------------------------------------

/**
 * a haverom adatmappaja.
 *
 * az electron app.getPath('appData') a %APPDATA% mappat adja vissza
 * windowson, es a benne levo app-specifikus mappat mi tesszuk hozza.
 */
export function getLegacyDir(appDataRoot: string): string {
  return path.join(appDataRoot, LEGACY_APP_NAME);
}

export function getVellumDir(appDataRoot: string): string {
  return path.join(appDataRoot, APP_NAME);
}

// ----------------------------------------------------------------------------
// beallitasok atvetele
// ----------------------------------------------------------------------------

/**
 * atveszi a regi beallitasokat, es kiegesziti az uj mezokkel.
 *
 * az ismeretlen kulcsokat figyelmen kivul hagyjuk (lehet, hogy a haveromban
 * volt olyan beallitas, ami nalunk mar nincs), a hianyzokat pedig
 * feltoltjuk a defaultokbol.
 */
function mergeSettings(legacy: unknown): {
  settings: VellumSettings;
  carriedOver: string[];
} {
  const result: VellumSettings = { ...DEFAULT_SETTINGS };
  const carriedOver: string[] = [];

  if (!legacy || typeof legacy !== 'object') {
    return { settings: result, carriedOver };
  }

  const source = legacy as Record<string, unknown>;

  // csak azokat a kulcsokat vesszuk at, amik nalunk is leteznek,
  // es a tipusuk is stimmel
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof VellumSettings)[]) {
    // autostart is never inherited: it must be an explicit choice in Vellum
    if (key === 'startWithWindows') continue;
    const value = source[key];

    if (value === undefined) continue;

    const expectedType = typeof DEFAULT_SETTINGS[key];
    const actualType = typeof value;

    if (expectedType !== actualType) continue;

    // tombnel es objektumnal kulon ellenorzes kell
    if (Array.isArray(DEFAULT_SETTINGS[key]) !== Array.isArray(value)) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)[key] = value;
    carriedOver.push(key);
  }

  return { settings: result, carriedOver };
}

// ----------------------------------------------------------------------------
// fo migracios fuggveny
// ----------------------------------------------------------------------------

/**
 * lefuttatja a migraciot, ha meg nem tortent meg.
 *
 * a lepesek:
 *   1. ha mar van vellum mappa marker fajllal, nincs teendo
 *   2. ha nincs haverom mappa, tiszta indulas
 *   3. mappa letrehozasa
 *   4. settings.json atvetele es kiegeszitese
 *   5. memory.md atmasolasa memory.legacy.md neven
 *   6. marker fajl kiirasa
 */
export async function runMigrationIfNeeded(
  appDataRoot: string,
): Promise<MigrationResult> {
  const legacyDir = getLegacyDir(appDataRoot);
  const vellumDir = getVellumDir(appDataRoot);
  const markerPath = path.join(vellumDir, FILES.migrationMarker);

  const warnings: string[] = [];

  // --- 1. mar megtortent? ---
  try {
    await fs.access(markerPath);

    return {
      migrated: false,
      settingsMigrated: false,
      memoryFound: false,
      warnings: [],
    };
  } catch {
    // nincs marker, mehet a migracio
  }

  // --- 2. van egyaltalan regi telepites? ---
  let legacyExists = false;

  try {
    const stat = await fs.stat(legacyDir);
    legacyExists = stat.isDirectory();
  } catch {
    legacyExists = false;
  }

  // --- 3. mappa letrehozasa ---
  try {
    await fs.mkdir(vellumDir, { recursive: true });
    await fs.mkdir(path.join(vellumDir, FILES.skillsDir), { recursive: true });
  } catch (error) {
    return {
      migrated: false,
      settingsMigrated: false,
      memoryFound: false,
      warnings,
      error:
        error instanceof Error
          ? `nem sikerült létrehozni az adatmappát: ${error.message}`
          : 'nem sikerült létrehozni az adatmappát',
    };
  }

  if (!legacyExists) {
    // tiszta indulas: csak a marker fajlt irjuk ki, hogy legkozelebb
    // ne probalkozzunk ujra
    await writeMarker(markerPath, 'none');

    return {
      migrated: false,
      settingsMigrated: false,
      memoryFound: false,
      warnings: [],
    };
  }

  // --- 4. beallitasok ---
  let settingsMigrated = false;

  try {
    const legacySettingsPath = path.join(legacyDir, FILES.settings);
    const raw = await fs.readFile(legacySettingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);

    const { settings, carriedOver } = mergeSettings(parsed);

    await fs.writeFile(
      path.join(vellumDir, FILES.settings),
      JSON.stringify(settings, null, 2),
      'utf-8',
    );

    settingsMigrated = true;

    if (carriedOver.length === 0) {
      warnings.push(
        'a régi beállításfájl üres volt vagy nem tartalmazott ismert kulcsot',
      );
    }
  } catch {
    warnings.push(
      'a régi beállítások nem voltak beolvashatók, alapértelmezettekkel indulunk',
    );
  }

  // --- 5. memoria ---
  // FONTOS: itt csak atmasoljuk. az atalakitas tipizalt bejegyzesekke
  // az F3-ban tortenik, a memoryLearner.migrateLegacyMemory fuggvennyel,
  // mert ahhoz mar kell a modell.
  let memoryFound = false;

  try {
    const legacyMemoryPath = path.join(legacyDir, 'memory.md');
    const content = await fs.readFile(legacyMemoryPath, 'utf-8');

    if (content.trim().length > 0) {
      await fs.writeFile(
        path.join(vellumDir, FILES.legacyMemory),
        content,
        'utf-8',
      );

      memoryFound = true;
    }
  } catch {
    // nincs regi memoria, ez teljesen rendben van
  }

  // --- 6. marker ---
  await writeMarker(markerPath, 'haverom');

  return {
    migrated: true,
    settingsMigrated,
    memoryFound,
    warnings,
  };
}

async function writeMarker(markerPath: string, from: string): Promise<void> {
  const marker: MigrationMarker = {
    from,
    at: Date.now(),
    version: 1,
  };

  try {
    await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8');
  } catch {
    // ha a marker nem irhato, a migracio legkozelebb ujra lefut.
    // ez nem katasztrofa, mert idempotens.
  }
}

// ----------------------------------------------------------------------------
// felhasznaloi uzenet
// ----------------------------------------------------------------------------

/**
 * a chatben megjeleno diszkret uzenet a migracio utan.
 * null, ha nem tortent semmi emlitesre melto.
 */
export function buildMigrationNotice(result: MigrationResult): string | null {
  if (!result.migrated) return null;

  const parts: string[] = [tr('migration.done')];

  if (result.memoryFound) parts.push(tr('migration.memory'));
  if (result.warnings.length > 0) parts.push(tr('migration.note', { warnings: result.warnings.join('; ') }));
  parts.push(tr('migration.untouched'));

  return parts.join(' ');
}

// ----------------------------------------------------------------------------
// ellenorzes: van-e meg feldolgozatlan regi memoria
// ----------------------------------------------------------------------------

/**
 * megnezi, hogy van-e memory.legacy.md, amit meg nem alakitottunk at.
 *
 * ezt az F3 hasznalja: az elso inditaskor, amikor mar van modell,
 * lefuttatja rajta a migrateLegacyMemory-t.
 */
export async function getPendingLegacyMemory(
  vellumDir: string,
): Promise<string | null> {
  const legacyMemoryPath = path.join(vellumDir, FILES.legacyMemory);
  const memoryPath = path.join(vellumDir, FILES.memory);

  // ha mar van uj memoria fajl, akkor az atalakitas megtortent
  try {
    await fs.access(memoryPath);
    return null;
  } catch {
    // meg nincs uj memoria, mehet tovabb
  }

  try {
    const content = await fs.readFile(legacyMemoryPath, 'utf-8');
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

/** a sikeres atalakitas utan atnevezzuk, hogy ne fusson le ujra */
export async function markLegacyMemoryProcessed(
  vellumDir: string,
): Promise<void> {
  const legacyMemoryPath = path.join(vellumDir, FILES.legacyMemory);
  const processedPath = path.join(vellumDir, 'memory.legacy.processed.md');

  try {
    await fs.rename(legacyMemoryPath, processedPath);
  } catch {
    // ha nem sikerul, legrosszabb esetben ujra lefut -- a duplikatum-
    // szures ugyis kiszuri
  }
}
