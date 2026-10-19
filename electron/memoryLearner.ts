// ============================================================================
// vellum - memoryLearner.ts (F3)
// ============================================================================
// automatikus memoria-tanulas.
//
// a haveromban amit nem irtal be kezzel, azt nem jegyezte meg. ez a modul
// ezt oldja meg: a beszelgetes vegen kiszedi az uj, megjegyzesre erdemes
// tenyeket egy strukturalt kimenetes hivassal.
//
// A LEGFONTOSABB SZABALY: a javaslatok SOHA nem kerulnek automatikusan a
// memoriaba. mindig jovahagyas kell.
//
// miert: jovahagyas nelkul a memoria fel ev alatt szemetdomb lesz, es a
// modell viselkedese kiszamithatatlanna valik. ez tapasztalati szabaly,
// nem ovatoskodas.
// ============================================================================

import { oneShotSimple } from './ollamaOneShot';
import {
  MemoryMigrationSchema,
  MemoryMigrationJsonSchema,
  type MemoryMigrationParsed,
} from './schemas';
import { addCandidates } from './memory';

// ----------------------------------------------------------------------------
// konfiguracio
// ----------------------------------------------------------------------------

export interface LearnerConfig {
  host: string;
  model: string;
  numCtx: number;
  /** hany felhasznaloi uzenet utan fusson le automatikusan */
  runAfterUserMessages: number;
}

let config: LearnerConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 16384,
  runAfterUserMessages: 10,
};

export function configureLearner(next: Partial<LearnerConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// migracio a regi memory.md-bol
// ----------------------------------------------------------------------------

/**
 * a haverom szabad szoveges memory.md-jet alakitja tipizalt bejegyzesekke.
 *
 * egyszer fut le, a forkolas utani elso inditaskor.
 *
 * FONTOS: az eredmeny NEM kerul egybol a memoriaba, hanem javaslatkent.
 * a felhasznalo egy kattintassal elfogadhatja mindet, vagy egyesevel.
 */
export async function migrateLegacyMemory(
  legacyContent: string,
): Promise<{
  ok: boolean;
  migrated: number;
  fallbackUsed: boolean;
  error?: string;
}> {
  const trimmed = legacyContent.trim();

  if (trimmed.length === 0) {
    return { ok: true, migrated: 0, fallbackUsed: false };
  }

  const system = [
    'Te egy adatátalakító segéd vagy.',
    'A feladatod: egy szabad szöveges jegyzetből tipizált memóriabejegyzéseket',
    'csinálni.',
    '',
    'TÍPUSOK:',
    '- fact: tartós tény a felhasználóról',
    '- person: tény egy másik emberről',
    '- project: projekt, amin dolgozik',
    '- preference: ízlés, hajlam',
    '- style: kemény formai utasítás (pl. "mindig magyarul válaszolj")',
    '',
    'PRIORITÁS 1-től 5-ig, ahol 5 a legfontosabb.',
    'A stílus-utasítások általában 4-5, az érdekességek 2-3.',
    '',
    'Minden bejegyzés egy tömör mondat legyen.',
    'Ha egy sor több információt tartalmaz, bontsd szét.',
    'Magyarul fogalmazz.',
  ].join('\n');

  const user = [
    'Alakítsd át az alábbi jegyzetet tipizált bejegyzésekké.',
    '',
    '---',
    trimmed.length > 4000 ? trimmed.slice(0, 4000) + '\n[...]' : trimmed,
    '---',
  ].join('\n');

  const result = await oneShotSimple<MemoryMigrationParsed>(
    {
      host: config.host,
      model: config.model,
      system,
      user,
      schema: MemoryMigrationJsonSchema,
      numCtx: config.numCtx,
      timeoutMs: 120000,
    },
    (value) => MemoryMigrationSchema.parse(value),
  );

  // Fallback when the model is not reachable: the text becomes ONE suggestion
  // (not an active entry -- the notice says "suggestion", and nothing reaches
  // the prompt without approval). The full original stays in memory.legacy.md.
  if (!result.ok || !result.data) {
    await addCandidates([{ type: 'fact', content: trimmed.slice(0, 500), confidence: 0.5 }], null);

    return {
      ok: true,
      migrated: 1,
      fallbackUsed: true,
      error: result.error,
    };
  }

  const entries = result.data.entries;

  if (entries.length === 0) {
    return { ok: true, migrated: 0, fallbackUsed: false };
  }

  // javaslatkent kerulnek be, nem kesz bejegyzeskent
  const added = await addCandidates(
    entries.map((e) => ({
      type: e.type,
      content: e.content,
      confidence: 0.7,
    })),
    null,
  );

  return { ok: true, migrated: added, fallbackUsed: false };
}
