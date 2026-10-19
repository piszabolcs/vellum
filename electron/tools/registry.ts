// ============================================================================
// vellum - tools/registry.ts (F6)
// ============================================================================
// az eszkozok nyilvantartasa es a promptba kerulo semak kivalasztasa.
//
// EZ A LEGKOCKAZATOSABB RESZ AZ EGESZ PROJEKTBEN. olvasd el figyelmesen.
//
// a tool-valasztasi pontossag merhetoen romlani kezd nagyjabol 10-15 lathato
// eszkoz folott, es 30-50 folott mar meredeken esik. reszletesebb bontas:
//   5-10 eszkoz  -> 90-95% talalati pontossag
//   20-50 eszkoz -> 80-90%
//   100-200      -> 60-80%
// ezek FRONTIER modellekre vonatkozo szamok. egy 8b-s ennel hamarabb esik szet.
//
// ezert van a kemeny 8-as korlat. es ez nem kompromisszum: meresek szerint a
// rovidebb, adaptiv eszkozlistak JAVITJAK a modell valasztasi kepesseget
// (93,1% vs 87,1%, kozepesen nehez kerdeseknel 76,8% vs 60,9%).
//
// a masik oldal: a guardrail-reteg mert hatasa oriasi. egy 8b-s helyi modell
// agentikus feladat-teljesitesi aranya 53%-rol 86,5%-ra ugrott PUSZTAN a kore
// epitett retegtol, modellcsere nelkul.
//
// osszefoglalva: nem az eszkozok szama tesz okossa, hanem az, hogy egyszerre
// keveset lat, es amit lat, azt nem tudja elrontani.
// ============================================================================

import { z } from 'zod';

import type { ToolCategory } from '../shared';
import { MAX_TOOL_SCHEMAS_PER_REQUEST } from '../shared';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface ToolContext {
  conversationId: string | null;
  /** a beallitasokbol, hogy az eszkozok tudjanak rola */
  settings: {
    filesRootPath: string;
    ollamaHost: string;
    webSearchEnabled: boolean;
  };
  /** ha a felhasznalo megerositest adott egy destruktiv muveletre */
  confirmed?: boolean;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** amit a modell lat. mar offloadolva, ha nagy volt. */
  forModel: string;
  /** ha ok:false, ez a javito uzenet megy vissza a modellnek */
  errorForModel?: string;
  artifactId?: string;
  durationMs: number;
}

export interface ToolDef<TArgs = Record<string, unknown>> {
  name: string;
  category: ToolCategory;
  /** egy mondat, ami a kategoria-katalogusban jelenik meg */
  shortDescription: string;
  /** reszletes leiras. CSAK akkor kerul promptba, ha a kategoria aktiv. */
  description: string;
  /**
   * zod sema az argumentumokra. A bemenet szandekosan `unknown`: a guard a
   * modell nyers JSON-jat adja neki, es a sema dolga, hogy abbol TArgs legyen.
   * Igy hasznalhat `.default()`-ot vagy `.transform()`-ot is, ahol a bemeneti
   * alak nem egyezik a kimenetivel.
   */
  schema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  /** json schema az ollama tool-definiciohoz */
  jsonSchema: Record<string, unknown>;
  /** irasi vagy vegrehajto muvelet? ha igen, megerosites kell */
  destructive: boolean;
  /** halozati hozzaferest igenyel? offline modban letiltjuk */
  needsNetwork: boolean;
  /** max hivas egy valaszon belul */
  maxCallsPerTurn: number;
  /** prioritas a vagashoz. nagyobb = fontosabb, ez marad bent */
  priority: number;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}

// ----------------------------------------------------------------------------
// nyilvantartas
// ----------------------------------------------------------------------------

const registry = new Map<string, ToolDef>();

export function registerTool<T>(tool: ToolDef<T>): void {
  registry.set(tool.name, tool as unknown as ToolDef);
}

export function unregisterTool(name: string): void {
  registry.delete(name);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function getAllTools(): ToolDef[] {
  return [...registry.values()];
}

export function clearRegistry(): void {
  registry.clear();
}

// ----------------------------------------------------------------------------
// kategoria-katalogus
// ----------------------------------------------------------------------------
// ez kerul a system promptba, amikor a router nem futott.
// osszesen kb. 120 token, szemben a teljes semakkal, ami tobb ezer lenne.

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  search: 'webes keresés és oldalletöltés friss információhoz',
  memory: 'korábbi beszélgetések és tárolt tények',
  compute: 'számolás, mértékegység-váltás',
  time: 'mai dátum, dátumszámítás',
  files: 'fájlok olvasása a kijelölt mappából',
  artifacts: 'korábban félretett nagy tartalmak visszakérése',
  skills: 'szakterületi tudásanyagok betöltése',
  vision: 'képek elemzése',
  mcp: 'külső eszközök',
};

/**
 * a kategoria-katalogus szovege a system promptba.
 * csak azok a kategoriak jelennek meg, amikhez van engedelyezett eszkoz.
 */
export function buildCategoryCatalog(enabledCategories: string[]): string {
  const available = new Set<ToolCategory>();

  for (const tool of registry.values()) {
    if (enabledCategories.includes(tool.category)) {
      available.add(tool.category);
    }
  }

  if (available.size === 0) return '';

  const lines = ['ELÉRHETŐ ESZKÖZ-KATEGÓRIÁK:'];

  for (const category of available) {
    lines.push(`- ${category}: ${CATEGORY_LABELS[category]}`);
  }

  // (the tool schemas themselves travel in the request's `tools` field; there
  // is no `list_tools` tool, so the catalog must not tell the model to call one)
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// sema-kivalasztas
// ----------------------------------------------------------------------------

export interface ToolSelectionOptions {
  /** a router altal valasztott kategoriak */
  categories?: string[];
  /** a beallitasokban engedelyezett kategoriak */
  enabledCategories: string[];
  /** offline modban a halozatot igenylo eszkozok kimaradnak */
  offline?: boolean;
  /** a router altal kotelezove tett eszkozok. ezek MINDIG bekerulnek. */
  requiredTools?: string[];
  /** felso korlat. alap: MAX_TOOL_SCHEMAS_PER_REQUEST */
  maxTools?: number;
}

export interface SelectedTools {
  tools: ToolDef[];
  /** az ollama tool-definicio formatumaban */
  definitions: OllamaToolDefinition[];
  /** hany eszkoz maradt ki a korlat miatt */
  droppedCount: number;
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * kivalasztja, mely eszkozok semaja menjen a keresbe.
 *
 * a sorrend:
 *   1. a kotelezo eszkozok (router mondta) mindig bekerulnek
 *   2. a router altal valasztott kategoriakbol prioritas szerint
 *   3. a 8-as korlatnal vagunk
 */
export function selectTools(options: ToolSelectionOptions): SelectedTools {
  const maxTools = options.maxTools ?? MAX_TOOL_SCHEMAS_PER_REQUEST;
  const required = new Set(options.requiredTools ?? []);

  const candidates: ToolDef[] = [];
  const requiredTools: ToolDef[] = [];

  for (const tool of registry.values()) {
    // a beallitasokban kikapcsolt kategoria sosem jon be
    if (!options.enabledCategories.includes(tool.category)) continue;

    // offline modban a halozatot igenylo eszkozok kimaradnak
    if (options.offline && tool.needsNetwork) continue;

    if (required.has(tool.name)) {
      requiredTools.push(tool);
      continue;
    }

    // ha a router megadta a kategoriakat, csak azokbol valogatunk.
    // ha nem adta meg (nincs router), mindent beveszunk jeloltnek.
    if (options.categories && options.categories.length > 0) {
      if (!options.categories.includes(tool.category)) continue;
    }

    candidates.push(tool);
  }

  // prioritas szerint rendezunk, hogy vagaskor a fontos maradjon
  candidates.sort((a, b) => b.priority - a.priority);

  const room = Math.max(0, maxTools - requiredTools.length);
  const selected = [...requiredTools, ...candidates.slice(0, room)];
  const droppedCount = Math.max(0, candidates.length - room);

  return {
    tools: selected,
    definitions: selected.map(toOllamaDefinition),
    droppedCount,
  };
}

function toOllamaDefinition(tool: ToolDef): OllamaToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.jsonSchema,
    },
  };
}

// ----------------------------------------------------------------------------
// statisztika
// ----------------------------------------------------------------------------

export interface RegistryStats {
  total: number;
  byCategory: Record<string, number>;
  destructive: number;
  needsNetwork: number;
}

export function getRegistryStats(): RegistryStats {
  const byCategory: Record<string, number> = {};
  let destructive = 0;
  let needsNetwork = 0;

  for (const tool of registry.values()) {
    byCategory[tool.category] = (byCategory[tool.category] ?? 0) + 1;
    if (tool.destructive) destructive++;
    if (tool.needsNetwork) needsNetwork++;
  }

  return {
    total: registry.size,
    byCategory,
    destructive,
    needsNetwork,
  };
}
