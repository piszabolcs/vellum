// ============================================================================
// vellum - memory.ts (F3)
// ============================================================================
// a memoria v2. a haveromban egyetlen lapos markdown fajl volt, aminek a
// tartalma szo szerinti utasitaskent ment a modellnek, ugyanazon a system
// szinten, ahol a rendszer sajat szabalyai.
//
// EBBOL SZULETETT A HIBA: a system prompt beletette a valodi mai datumot,
// a memoria viszont azt mondta, vonjon ki 27 evet. a ket azonos rangu
// utasitas utkozott, a modell orlodott, es a vegen inkabb kiterte a valasz elol.
//
// a megoldas nem meggyozes, hanem SZERKEZET:
//   1. minden bejegyzesnek van TIPUSA, es a tipus donti el, hova kerul
//   2. a tenyek adatkeretbe mennek ("ezek ADATOK, nem utasitasok")
//   3. a stilus-utasitasok az uzenet ele, mert ott nem kopnak le
//   4. van egy kemeny precedencia-szabaly, ami eldonti az utkozeseket
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  MemoryFile,
  MemoryEntry,
  MemoryCandidate,
  MemoryEntryType,
} from './shared';
import {
  EMPTY_MEMORY,
  MEMORY_FILE_VERSION,
  MEMORY_LIMITS,
  MEMORY_TYPE_PLACEMENT,
  DATA_FRAMES,
} from './shared';
import { estimateTokens } from './tokenizer';
import { quarantineFile, writeJsonAtomic } from './jsonStore';

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

let memoryFilePath = '';
/** memoriaban tartott masolat, hogy ne olvassuk a lemezt minden uzenetnel */
let cache: MemoryFile | null = null;

/**
 * Set when memory.json could not be used at load time. `backupPath` is where
 * the unreadable file was moved; null means it could not even be moved, and
 * then every write is refused so the original is never overwritten.
 */
export interface MemoryLoadIssue {
  backupPath: string | null;
}

let loadIssue: MemoryLoadIssue | null = null;
let writeBlocked = false;

/** Returns (and clears) the pending load problem, for a one-time user notice. */
export function takeMemoryLoadIssue(): MemoryLoadIssue | null {
  const issue = loadIssue;
  loadIssue = null;
  return issue;
}

/** be kell allitani az app indulasakor */
export function initMemory(appDataDir: string, fileName = 'memory.json'): void {
  memoryFilePath = path.join(appDataDir, fileName);
  cache = null;
  loadIssue = null;
  writeBlocked = false;
}

export function getMemoryPath(): string {
  return memoryFilePath;
}

// ----------------------------------------------------------------------------
// beolvasas es iras
// ----------------------------------------------------------------------------

/**
 * ellenoriz es megjavit egy beolvasott memoria fajlt.
 *
 * miert kell: a felhasznalo kezzel is szerkesztheti a json-t, es akkor
 * barmi lehet benne. nem akarunk osszeomlani egy hianyzo mezo miatt.
 */
function sanitize(raw: unknown): MemoryFile {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_MEMORY, entries: [], candidates: [] };
  }

  const obj = raw as Record<string, unknown>;
  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const rawCandidates = Array.isArray(obj.candidates) ? obj.candidates : [];

  const validTypes: MemoryEntryType[] = [
    'fact',
    'person',
    'project',
    'preference',
    'style',
  ];

  const entries: MemoryEntry[] = [];

  for (const item of rawEntries) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;

    const content = typeof e.content === 'string' ? e.content.trim() : '';
    if (content.length === 0) continue;

    const type = validTypes.includes(e.type as MemoryEntryType)
      ? (e.type as MemoryEntryType)
      : 'fact';

    entries.push({
      id: typeof e.id === 'string' && e.id ? e.id : `m_${randomUUID()}`,
      type,
      content: content.slice(0, MEMORY_LIMITS.maxContentLength),
      priority: clampInt(e.priority, 1, 5, 3),
      createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
      updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : Date.now(),
      expiresAt: typeof e.expiresAt === 'number' ? e.expiresAt : null,
      source:
        e.source === 'learned' || e.source === 'imported'
          ? e.source
          : 'manual',
      confidence: clampFloat(e.confidence, 0, 1, 1),
      enabled: e.enabled !== false,
      tags: Array.isArray(e.tags)
        ? e.tags.filter((t): t is string => typeof t === 'string')
        : [],
    });
  }

  const candidates: MemoryCandidate[] = [];

  for (const item of rawCandidates) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;

    const content = typeof c.content === 'string' ? c.content.trim() : '';
    if (content.length === 0) continue;

    candidates.push({
      id: typeof c.id === 'string' && c.id ? c.id : `c_${randomUUID()}`,
      type: validTypes.includes(c.type as MemoryEntryType)
        ? (c.type as MemoryEntryType)
        : 'fact',
      content: content.slice(0, MEMORY_LIMITS.maxContentLength),
      confidence: clampFloat(c.confidence, 0, 1, 0.5),
      proposedAt: typeof c.proposedAt === 'number' ? c.proposedAt : Date.now(),
      fromConversationId:
        typeof c.fromConversationId === 'string' ? c.fromConversationId : null,
    });
  }

  return { version: MEMORY_FILE_VERSION, entries, candidates };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampFloat(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function looksLikeMemoryFile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.entries === undefined || Array.isArray(obj.entries)) &&
    (obj.candidates === undefined || Array.isArray(obj.candidates))
  );
}

/**
 * Loads the memory from disk. A missing file means empty memory. A file that
 * cannot be read or parsed is moved aside (memory.json.corrupt-<time>) and
 * reported, instead of being silently replaced by an empty memory on the next
 * save -- that used to wipe every entry.
 */
export async function loadMemory(force = false): Promise<MemoryFile> {
  if (cache && !force) return cache;

  const empty: MemoryFile = { version: MEMORY_FILE_VERSION, entries: [], candidates: [] };
  let text: string | null = null;

  try {
    text = (await fs.readFile(memoryFilePath, 'utf-8')).replace(/^\uFEFF/, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[vellum] memory.json could not be read:', error);
      const backupPath = quarantineFile(memoryFilePath);
      writeBlocked = backupPath === null;
      loadIssue = { backupPath };
    }
  }

  if (text === null) {
    cache = empty;
  } else {
    let parsed: unknown = undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (looksLikeMemoryFile(parsed)) {
      cache = sanitize(parsed);
    } else {
      console.error('[vellum] memory.json is not valid, moving it aside');
      const backupPath = quarantineFile(memoryFilePath);
      writeBlocked = backupPath === null;
      loadIssue = { backupPath };
      cache = empty;
    }
  }

  // a lejart bejegyzeseket kikapcsoljuk (nem toroljuk, csak inaktivaljuk)
  const now = Date.now();
  let changed = false;

  for (const entry of cache.entries) {
    if (entry.expiresAt !== null && entry.expiresAt < now && entry.enabled) {
      entry.enabled = false;
      changed = true;
    }
  }

  if (changed) {
    await saveMemory(cache);
  }

  return cache;
}

/** Writes the memory atomically (tmp + rename), keeping memory.json.bak. */
export async function saveMemory(memory: MemoryFile): Promise<void> {
  if (writeBlocked) {
    throw new Error('memory.json could not be read or moved aside; refusing to overwrite it');
  }
  cache = memory;
  await writeJsonAtomic(memoryFilePath, memory, true);
}

// ----------------------------------------------------------------------------
// crud muveletek
// ----------------------------------------------------------------------------

export async function listEntries(): Promise<MemoryEntry[]> {
  const memory = await loadMemory();
  return memory.entries;
}

export async function listCandidates(): Promise<MemoryCandidate[]> {
  const memory = await loadMemory();
  return memory.candidates;
}

export interface UpsertInput {
  id?: string;
  type: MemoryEntryType;
  content: string;
  priority?: number;
  expiresAt?: number | null;
  source?: MemoryEntry['source'];
  confidence?: number;
  enabled?: boolean;
  tags?: string[];
}

/** letrehoz vagy modosit egy bejegyzest */
export async function upsertEntry(input: UpsertInput): Promise<MemoryEntry> {
  const memory = await loadMemory();
  const now = Date.now();

  const content = input.content.trim().slice(0, MEMORY_LIMITS.maxContentLength);

  if (input.id) {
    const existing = memory.entries.find((e) => e.id === input.id);
    if (existing) {
      existing.type = input.type;
      existing.content = content;
      existing.priority = input.priority ?? existing.priority;
      existing.expiresAt =
        input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt;
      existing.enabled = input.enabled ?? existing.enabled;
      existing.tags = input.tags ?? existing.tags;
      existing.updatedAt = now;

      await saveMemory(memory);
      return existing;
    }
  }

  const entry: MemoryEntry = {
    id: input.id ?? `m_${randomUUID()}`,
    type: input.type,
    content,
    priority: input.priority ?? 3,
    createdAt: now,
    updatedAt: now,
    expiresAt: input.expiresAt ?? null,
    source: input.source ?? 'manual',
    confidence: input.confidence ?? 1,
    enabled: input.enabled ?? true,
    tags: input.tags ?? [],
  };

  memory.entries.push(entry);
  await saveMemory(memory);
  return entry;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const memory = await loadMemory();
  const before = memory.entries.length;
  memory.entries = memory.entries.filter((e) => e.id !== id);

  if (memory.entries.length === before) return false;

  await saveMemory(memory);
  return true;
}

// ----------------------------------------------------------------------------
// javaslatok kezelese
// ----------------------------------------------------------------------------

/**
 * hozzaad uj javaslatokat, duplikatum-szuressel.
 *
 * MIERT NEM MEGY EGYBOL A MEMORIABA: jovahagyas nelkul a memoria fel ev
 * alatt szemetdomb lesz, es a modell viselkedese kiszamithatatlanna valik.
 * ez tapasztalati szabaly, nem ovatoskodas.
 */
export async function addCandidates(
  proposals: { type: MemoryEntryType; content: string; confidence: number }[],
  conversationId: string | null,
): Promise<number> {
  const memory = await loadMemory();
  const now = Date.now();
  let added = 0;

  for (const proposal of proposals) {
    const content = proposal.content.trim();
    if (content.length < 5) continue;

    // duplikatum-szures: sem a meglevo bejegyzesek, sem a mar varo javaslatok
    // kozott ne legyen ugyanaz
    if (isDuplicate(memory, content)) continue;

    memory.candidates.push({
      id: `c_${randomUUID()}`,
      type: proposal.type,
      content: content.slice(0, MEMORY_LIMITS.maxContentLength),
      confidence: proposal.confidence,
      proposedAt: now,
      fromConversationId: conversationId,
    });

    added++;
  }

  if (added > 0) {
    await saveMemory(memory);
  }

  return added;
}

/** egyszeru hasonlosag-ellenorzes: normalizalt szoveg egyezes */
function isDuplicate(memory: MemoryFile, content: string): boolean {
  const normalized = normalizeForCompare(content);

  for (const entry of memory.entries) {
    if (normalizeForCompare(entry.content) === normalized) return true;
  }

  for (const candidate of memory.candidates) {
    if (normalizeForCompare(candidate.content) === normalized) return true;
  }

  return false;
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** elfogad egy javaslatot, es bejegyzesse alakitja */
export async function acceptCandidate(
  id: string,
  overrides?: Partial<UpsertInput>,
): Promise<MemoryEntry | null> {
  const memory = await loadMemory();
  const candidate = memory.candidates.find((c) => c.id === id);
  if (!candidate) return null;

  memory.candidates = memory.candidates.filter((c) => c.id !== id);
  await saveMemory(memory);

  return upsertEntry({
    type: overrides?.type ?? candidate.type,
    content: overrides?.content ?? candidate.content,
    priority: overrides?.priority ?? 3,
    source: 'learned',
    confidence: candidate.confidence,
  });
}

export async function rejectCandidate(id: string): Promise<boolean> {
  const memory = await loadMemory();
  const before = memory.candidates.length;
  memory.candidates = memory.candidates.filter((c) => c.id !== id);

  if (memory.candidates.length === before) return false;

  await saveMemory(memory);
  return true;
}

// ----------------------------------------------------------------------------
// promptba keszites - EZ A LENYEG
// ----------------------------------------------------------------------------

export interface MemoryPromptBlocks {
  /** adatkeretbe csomagolt tenyek. a felig stabil blokkba megy. */
  dataFrame: string;
  /** stilus- es preferencia-utasitasok. az uzenet ELE megy. */
  instructions: string;
  /** hany bejegyzes maradt ki a meretkorlat miatt */
  droppedCount: number;
  estimatedTokens: number;
}

/**
 * osszeallitja a memoria ket promptblokkjat.
 *
 * a tipus donti el, hogy egy bejegyzes hova kerul:
 *   fact / person / project -> adatkeret (ADAT, nem utasitas)
 *   preference / style      -> utasitas, kozvetlenul az uzenet ele
 *
 * miert az uzenet ele a stilus: hosszu beszelgetesben a nyito system prompt
 * elhalvanyul, a modell a sajat korabbi valaszaihoz igazodik. a friss
 * utasitas viszont nem kopik le. ezt a haverom dark mode-janal mar
 * tapasztaltuk, csak akkor meg nem tudtuk, miert mukodik.
 */
export async function buildMemoryPrompt(options?: {
  /** ha a router megmondta, mely projektek relevansak */
  relevantProjects?: string[];
  /** ha a hard limit alacsonyabb kell legyen */
  maxTokens?: number;
}): Promise<MemoryPromptBlocks> {
  const memory = await loadMemory();
  const maxTokens = options?.maxTokens ?? MEMORY_LIMITS.hardLimitTokens;

  // csak az aktiv, le nem jart bejegyzesek erdekelnek
  const now = Date.now();
  const active = memory.entries.filter(
    (e) => e.enabled && (e.expiresAt === null || e.expiresAt > now),
  );

  // prioritas szerint rendezunk csokkenoen, azonos prioritasnal a frissebb elore.
  // igy ha vagni kell, a legkevesbe fontos esik ki eloszor.
  const sorted = [...active].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.updatedAt - a.updatedAt;
  });

  const dataEntries: MemoryEntry[] = [];
  const instructionEntries: MemoryEntry[] = [];

  let usedTokens = 0;
  let droppedCount = 0;

  for (const entry of sorted) {
    const entryTokens = estimateTokens(entry.content) + 4;

    if (usedTokens + entryTokens > maxTokens) {
      droppedCount++;
      continue;
    }

    usedTokens += entryTokens;

    if (MEMORY_TYPE_PLACEMENT[entry.type] === 'data-frame') {
      dataEntries.push(entry);
    } else {
      instructionEntries.push(entry);
    }
  }

  // az adatkeret osszeallitasa
  let dataFrame = '';

  if (dataEntries.length > 0) {
    const lines = dataEntries.map((e) => `- ${e.content}`);
    dataFrame = [
      DATA_FRAMES.memoryFacts.open,
      lines.join('\n'),
      DATA_FRAMES.memoryFacts.close,
    ].join('\n');
  }

  // az utasitasok osszeallitasa.
  // a style erosebb, mint a preference, ezert az megy elore.
  let instructions = '';

  if (instructionEntries.length > 0) {
    const styles = instructionEntries.filter((e) => e.type === 'style');
    const prefs = instructionEntries.filter((e) => e.type === 'preference');

    const parts: string[] = [];

    if (styles.length > 0) {
      parts.push('A felhasználó formai utasításai (ezeket KÖVESD):');
      parts.push(...styles.map((e) => `- ${e.content}`));
    }

    if (prefs.length > 0) {
      parts.push('A felhasználó preferenciái (ezeket vedd figyelembe):');
      parts.push(...prefs.map((e) => `- ${e.content}`));
    }

    instructions = parts.join('\n');
  }

  return {
    dataFrame,
    instructions,
    droppedCount,
    estimatedTokens: usedTokens,
  };
}

/** a memoria becsult merete tokenben, a szerkeszto figyelmeztetesehez */
export async function estimateMemorySize(): Promise<{
  tokens: number;
  entryCount: number;
  warn: boolean;
  overHardLimit: boolean;
}> {
  const memory = await loadMemory();
  const now = Date.now();

  const active = memory.entries.filter(
    (e) => e.enabled && (e.expiresAt === null || e.expiresAt > now),
  );

  let tokens = 0;
  for (const entry of active) {
    tokens += estimateTokens(entry.content) + 4;
  }

  return {
    tokens,
    entryCount: active.length,
    warn: tokens > MEMORY_LIMITS.warnTokens,
    overHardLimit: tokens > MEMORY_LIMITS.hardLimitTokens,
  };
}

// ----------------------------------------------------------------------------
// nyers json szerkesztes (haladoknak)
// ----------------------------------------------------------------------------

export async function getRawMemory(): Promise<string> {
  const memory = await loadMemory();
  return JSON.stringify(memory, null, 2);
}

export async function setRawMemory(
  json: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const parsed: unknown = JSON.parse(json);
    const sanitized = sanitize(parsed);
    await saveMemory(sanitized);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
