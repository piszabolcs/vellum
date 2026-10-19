// ============================================================================
// vellum - tokenizer.ts
// ============================================================================
// ez NEM egy igazi tokenizer. csak becsles.
//
// miert eleg a becsles: nekunk nem a pontos szam kell, hanem az ARANY.
// azt akarjuk tudni, mennyire van tele a kontextus, hogy el tudjuk donteni,
// mikor kell offloadolni vagy osszefoglalni. egy 10%-os hiba ebben nem szamit.
//
// az F2-es eval harness kalibralni fogja: az ollama valasza tartalmazza a
// valodi prompt_eval_count erteket, azt hasonlitjuk ossze ezzel a becslessel.
// ============================================================================

import type { OllamaMessage, ContextUsage, ContextLevel } from './shared';
import { CONTEXT_THRESHOLDS } from './shared';

// ----------------------------------------------------------------------------
// kalibracios szorzok
// ----------------------------------------------------------------------------
// angol szovegnel a szokasos hozzavetoleges arany 4 karakter = 1 token.
// a magyar surubb (hosszabb szavak, ekezetek, ragozas), ott 3.6-tal osztunk.
// a kod meg annal is surubb, ott 3.

const CHARS_PER_TOKEN_LATIN = 4.0;
const CHARS_PER_TOKEN_HUNGARIAN = 3.6;
const CHARS_PER_TOKEN_CODE = 3.0;

/** minden uzenet korul van egy kis overhead: szerep, elvalasztok, formazas */
const PER_MESSAGE_OVERHEAD = 4;

// ----------------------------------------------------------------------------
// nyelvfelismeres (nagyon egyszeru)
// ----------------------------------------------------------------------------

/** a magyar specifikus ekezetes karakterek */
const HUNGARIAN_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g;

/**
 * megnezi, hogy a szoveg valoszinuleg magyar-e.
 * nem kell tokeletesnek lennie, csak azt donti el, melyik szorzot hasznaljuk.
 */
export function looksHungarian(text: string): boolean {
  if (text.length === 0) return false;

  const matches = text.match(HUNGARIAN_CHARS);
  if (!matches) return false;

  // ha a karakterek legalabb 1.5%-a magyar ekezetes, magyarnak vesszuk.
  // ez alacsony kuszob, de magyar szovegben siman megvan, angolban meg nincs.
  const ratio = matches.length / text.length;
  return ratio > 0.015;
}

// ----------------------------------------------------------------------------
// kodblokk felismeres
// ----------------------------------------------------------------------------

/**
 * szetszedi a szoveget kodblokkokra es sima prozara.
 * azert kell, mert a kod surubb tokenekben, mint a proza.
 */
function splitCodeAndProse(text: string): { code: string; prose: string } {
  let code = '';
  let prose = '';

  // a harmas backtick kozotti reszeket kodnak vesszuk.
  const parts = text.split('```');

  for (let i = 0; i < parts.length; i++) {
    // a paratlan indexu reszek vannak a backtickek kozott -> azok a kodblokkok
    if (i % 2 === 1) {
      code += parts[i];
    } else {
      prose += parts[i];
    }
  }

  return { code, prose };
}

// ----------------------------------------------------------------------------
// fo becslo fuggvenyek
// ----------------------------------------------------------------------------

/**
 * megbecsuli, hany tokent jelent egy szovegdarab.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  const { code, prose } = splitCodeAndProse(text);

  let total = 0;

  // a kodreszt mindig a suru szorzoval szamoljuk
  if (code.length > 0) {
    total += code.length / CHARS_PER_TOKEN_CODE;
  }

  // a prozaresznel megnezzuk, magyar-e
  if (prose.length > 0) {
    const divisor = looksHungarian(prose)
      ? CHARS_PER_TOKEN_HUNGARIAN
      : CHARS_PER_TOKEN_LATIN;
    total += prose.length / divisor;
  }

  return Math.ceil(total);
}

/**
 * megbecsuli egy teljes uzenetlista token-meretet.
 */
export function estimateMessagesTokens(messages: OllamaMessage[]): number {
  let total = 0;

  for (const message of messages) {
    total += estimateTokens(message.content);
    total += PER_MESSAGE_OVERHEAD;

    // a gondolkodas is tokenbe kerul, ha visszakuldjuk a modellnek.
    // alapbol nem kuldjuk vissza, de ha valaki bekapcsolja, szamoljon vele.
    if (message.thinking) {
      total += estimateTokens(message.thinking);
    }

    // a tool hivasok json-je is helyet foglal
    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        total += estimateTokens(JSON.stringify(call));
      }
    }
  }

  return total;
}

/**
 * eldonti, milyen szinten all a kontextus kihasznaltsaga.
 *
 * a hatarok mogotti indoklas:
 * - 60% alatt minden rendben, a modell jol kovetkeztet
 * - 60-75% kozott mar erdemes figyelni
 * - 75% folott indul a compaction, mert 80% folott mar merheto a romlas
 */
export function levelFromRatio(ratio: number): ContextLevel {
  if (ratio >= CONTEXT_THRESHOLDS.critical) return 'critical';
  if (ratio >= CONTEXT_THRESHOLDS.warn) return 'warn';
  return 'ok';
}

/**
 * a teljes kontextus-kihasznaltsagot szamolja ki, bontassal egyutt.
 *
 * a bontas azert fontos, mert latni akarjuk, MI foglalja a helyet.
 * ha a memoria 3000 tokent visz el, az latszodjon a felhasznalonak is.
 */
export function contextUsage(
  messages: OllamaMessage[],
  numCtx: number,
  hints?: {
    /** melyik uzenetek tartoznak a memoriahoz (index szerint) */
    memoryIndices?: number[];
    /** melyik uzenetek a behuzott kontextus (kereses, retrieval) */
    retrievedIndices?: number[];
  },
): ContextUsage {
  const breakdown = {
    system: 0,
    memory: 0,
    history: 0,
    retrieved: 0,
    current: 0,
  };

  const memorySet = new Set(hints?.memoryIndices ?? []);
  const retrievedSet = new Set(hints?.retrievedIndices ?? []);
  const lastIndex = messages.length - 1;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const tokens = estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;

    // az utolso user uzenet mindig az "aktualis"
    if (i === lastIndex && message.role === 'user') {
      breakdown.current += tokens;
      continue;
    }

    if (memorySet.has(i)) {
      breakdown.memory += tokens;
      continue;
    }

    if (retrievedSet.has(i)) {
      breakdown.retrieved += tokens;
      continue;
    }

    if (message.role === 'system') {
      breakdown.system += tokens;
      continue;
    }

    breakdown.history += tokens;
  }

  const used =
    breakdown.system +
    breakdown.memory +
    breakdown.history +
    breakdown.retrieved +
    breakdown.current;

  const ratio = numCtx > 0 ? used / numCtx : 0;

  return {
    used,
    total: numCtx,
    ratio,
    level: levelFromRatio(ratio),
    breakdown,
  };
}

// ----------------------------------------------------------------------------
// kalibracio
// ----------------------------------------------------------------------------

export interface CalibrationSample {
  estimated: number;
  actual: number;
}

/**
 * osszehasonlitja a becslest a valodi ertekekkel, es javaslatot ad
 * a szorzo modositasara. az F2-es eval harness hasznalja.
 */
export function calibrationReport(samples: CalibrationSample[]): {
  averageErrorPercent: number;
  suggestion: string;
} {
  if (samples.length === 0) {
    return { averageErrorPercent: 0, suggestion: 'nincs adat a kalibraciohoz' };
  }

  let errorSum = 0;
  let counted = 0;

  for (const sample of samples) {
    if (sample.actual === 0) continue;
    errorSum += (sample.estimated - sample.actual) / sample.actual;
    counted++;
  }

  if (counted === 0) {
    return { averageErrorPercent: 0, suggestion: 'nincs ervenyes minta' };
  }

  const averageError = errorSum / counted;
  const averageErrorPercent = Math.round(averageError * 1000) / 10;

  let suggestion: string;

  if (Math.abs(averageErrorPercent) < 10) {
    suggestion = 'a becsles pontossaga elfogadhato, nem kell modositani';
  } else if (averageErrorPercent > 0) {
    suggestion =
      `a becsles ${averageErrorPercent}%-kal tul magas. ` +
      'noveld a CHARS_PER_TOKEN szorzokat.';
  } else {
    suggestion =
      `a becsles ${Math.abs(averageErrorPercent)}%-kal tul alacsony. ` +
      'csokkentsd a CHARS_PER_TOKEN szorzokat.';
  }

  return { averageErrorPercent, suggestion };
}
