import type { ChatMessage } from '../types/chat';

/**
 * Kontextus-kihasznaltsag becsles a renderer oldalan (F5).
 *
 * Ez NEM igazi tokenizer, csak becsles -- nekunk nem a pontos szam kell, hanem
 * az ARANY: mennyire van tele a kontextus. Egy 10%-os hiba ebben nem szamit.
 *
 * A szorzok a main-process tokenizer.ts-evel egyeznek: a magyar surubb
 * (hosszabb szavak, ekezetek, ragozas), a kod meg annal is surubb.
 */

const CHARS_PER_TOKEN_LATIN = 4.0;
const CHARS_PER_TOKEN_HUNGARIAN = 3.6;
const CHARS_PER_TOKEN_CODE = 3.0;
const PER_MESSAGE_OVERHEAD = 4;

/** a system reteg becsult merete: persona + precedencia + szabalyok + katalogusok */
const SYSTEM_BASELINE_TOKENS = 500;

const HUNGARIAN_CHARS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g;

function looksHungarian(text: string): boolean {
  if (text.length === 0) return false;
  const matches = text.match(HUNGARIAN_CHARS);
  if (!matches) return false;
  return matches.length / text.length > 0.015;
}

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  // a harmas backtick kozotti reszeket kodnak vesszuk
  let code = '';
  let prose = '';
  const parts = text.split('```');
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) code += parts[i];
    else prose += parts[i];
  }

  let total = 0;
  if (code.length > 0) total += code.length / CHARS_PER_TOKEN_CODE;
  if (prose.length > 0) {
    const divisor = looksHungarian(prose) ? CHARS_PER_TOKEN_HUNGARIAN : CHARS_PER_TOKEN_LATIN;
    total += prose.length / divisor;
  }
  return Math.ceil(total);
}

/**
 * A legutobbi valasznal az Ollama megmondta, hany token volt VALOJABAN a prompt
 * (`prompt_eval_count`). Ez pontosabb minden becslesnel -- a becsles nem tud a
 * memoriarol, a rendszer-retegekrol es a behuzott forrasokrol, ezert rendszeresen
 * alabecsul.
 *
 * A mert szam viszont csak addig a hivasig ervenyes, ezert hozzaadjuk az azota
 * keletkezett uzenetek becsult meretet -- beleertve magat a valaszt is, mert az
 * a kovetkezo promptba mar bekerul.
 *
 * null, ha meg nincs egyetlen meres sem (a beszelgetes elso uzeneteig).
 */
export function measuredUsed(messages: ChatMessage[]): number | null {
  let lastIndex = -1;
  let promptTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const tokens = message.stats?.promptTokens;

    if (message.role === 'assistant' && typeof tokens === 'number' && tokens > 0) {
      lastIndex = i;
      promptTokens = tokens;
      break;
    }
  }

  if (lastIndex === -1) return null;

  let since = 0;
  for (let i = lastIndex; i < messages.length; i++) {
    if (messages[i].error) continue;
    since += estimateTokens(messages[i].content) + PER_MESSAGE_OVERHEAD;
  }

  return promptTokens + since;
}

export type ContextLevel = 'ok' | 'warn' | 'critical';

export interface ContextUsageResult {
  used: number;
  total: number;
  ratio: number;
  level: ContextLevel;
  breakdown: {
    system: number;
    memory: number;
    history: number;
    retrieved: number;
    current: number;
  };
}

export function levelFromRatio(ratio: number): ContextLevel {
  if (ratio >= 0.75) return 'critical';
  if (ratio >= 0.6) return 'warn';
  return 'ok';
}

/**
 * A beszelgetes becsult kontextus-merete.
 *
 * A hibabuborekokat KIHAGYJUK, mert azok nem mennek a modellnek (a store szuri
 * oket) -- ha beleszamolnank, tul magas erteket mutatnank.
 */
export function contextUsage(
  messages: ChatMessage[],
  numCtx: number,
  summary?: string
): ContextUsageResult {
  const breakdown = {
    system: SYSTEM_BASELINE_TOKENS,
    memory: 0,
    history: 0,
    retrieved: 0,
    current: 0
  };

  if (summary) breakdown.system += estimateTokens(summary);

  const usable = messages.filter((m) => !m.error);
  for (let i = 0; i < usable.length; i++) {
    const message = usable[i];
    const tokens = estimateTokens(message.content) + PER_MESSAGE_OVERHEAD;

    // az utolso felhasznaloi uzenet az "aktualis"
    if (i === usable.length - 1 && message.role === 'user') {
      breakdown.current += tokens;
      continue;
    }
    breakdown.history += tokens;

    // a behuzott forrasok kulon sorban latszanak, mert azok a leggyakoribb
    // "hirtelen megtelt a kontextus" okozok
    if (message.sources && message.sources.length > 0) {
      breakdown.retrieved += message.sources.length * 120;
    }
  }

  const used =
    breakdown.system +
    breakdown.memory +
    breakdown.history +
    breakdown.retrieved +
    breakdown.current;
  const ratio = numCtx > 0 ? used / numCtx : 0;

  return { used, total: numCtx, ratio, level: levelFromRatio(ratio), breakdown };
}
