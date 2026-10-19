// ============================================================================
// vellum - tools/guard.ts (F6)
// ============================================================================
// EZ A LEGFONTOSABB FAJL AZ ESZKOZ-RETEGBEN.
//
// a kis modellek negy jellegzetes modon buknak el eszkozhasznalatnal:
//   1. HIBAS TOOL-HIVAS: rossz json, rossz parameternevek, hianyzo mezok
//   2. LEPESKIHAGYAS: kovetkeztetesre ugrik, mielott mindent meghivott volna
//   3. ONJAVITASI KEPTELENSEG: hiba utan ugyanazt ismetli, vagy feladja
//   4. KONTEXTUS-ELSODRODAS: tobb fordulon at elveszti az eredeti feladatot
//
// ez a modul mind a negy ellen ved. a mert hatas: egy 8b-s modell agentikus
// feladat-teljesitesi aranya 53%-rol 86,5%-ra ugrott ettol a retegtol.
// ============================================================================

import { z } from 'zod';

import type { ToolContext, ToolResult } from './registry';
import { getTool } from './registry';

// ----------------------------------------------------------------------------
// allapot egy valaszon belul
// ----------------------------------------------------------------------------

export interface ToolLoopState {
  /** osszes hivas eddig */
  totalCalls: number;
  /** eszkozonkenti hivasszam */
  callsPerTool: Map<string, number>;
  /** hany javito kort hasznaltunk el */
  nudgesUsed: number;
  /** a router altal kotelezove tett, meg le nem futott eszkozok */
  requiredToolsPending: string[];
  /** hanyszor kenyszeritettuk mar ki a kotelezo eszkozt */
  forcedToolReminders: number;
  /** korabbi hivasok eredmenye, hogy ne fusson le ketszer ugyanaz */
  callCache: Map<string, ToolResult>;
  startedAt: number;
}

export function createLoopState(requiredTools: string[] = []): ToolLoopState {
  return {
    totalCalls: 0,
    callsPerTool: new Map(),
    nudgesUsed: 0,
    requiredToolsPending: [...requiredTools],
    forcedToolReminders: 0,
    callCache: new Map(),
    startedAt: Date.now(),
  };
}

export interface GuardConfig {
  maxToolCallsPerTurn: number;
  maxNudges: number;
  /** hard deadline for one tool execution; a slow tool must not stall the reply */
  toolTimeoutMs: number;
}

const DEFAULT_CONFIG: GuardConfig = {
  maxToolCallsPerTurn: 6,
  maxNudges: 2,
  toolTimeoutMs: 90_000,
};

class ToolTimeoutError extends Error {}

/** Races the tool against the deadline. The tool itself is not cancelled,
 *  but the answer no longer waits for it. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolTimeoutError(`no result within ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// javito uzenetek (nudge)
// ----------------------------------------------------------------------------

/**
 * celzott javito uzenet.
 *
 * NEM altalanos "probald ujra", hanem konkret: mi volt a baj, mit varunk,
 * es mit csinaljon. a kis modellek altalanos hibauzenetre nem tudnak
 * javitani, konkretra viszont igen.
 */
export function buildNudge(
  toolName: string,
  problem: string,
  hint: string,
): string {
  return [
    `A(z) ${toolName} eszköz hívása nem sikerült.`,
    `Hiba: ${problem}`,
    `Javítás: ${hint}`,
    'Hívd meg újra a javított argumentumokkal. Ne magyarázkodj, csak hívd.',
  ].join('\n');
}

/**
 * a zod hibabol emberi (es modell szamara ertheto) leirast csinal.
 */
function describeZodError(error: z.ZodError): { problem: string; hint: string } {
  const issues = error.issues.slice(0, 3);

  const problems: string[] = [];
  const hints: string[] = [];

  for (const issue of issues) {
    const path = issue.path.join('.') || '(gyökér)';

    switch (issue.code) {
      case 'invalid_type':
        problems.push(
          `a(z) "${path}" mező típusa rossz: ${issue.expected} kellene, de ${issue.received} jött`,
        );
        hints.push(`a(z) "${path}" mező legyen ${issue.expected} típusú`);
        break;

      case 'too_small':
        problems.push(`a(z) "${path}" mező túl rövid vagy túl kicsi`);
        hints.push(`adj meg értelmes értéket a(z) "${path}" mezőnek`);
        break;

      case 'too_big':
        problems.push(`a(z) "${path}" mező túl hosszú vagy túl nagy`);
        hints.push(`rövidítsd le a(z) "${path}" mezőt`);
        break;

      case 'invalid_enum_value':
        problems.push(
          `a(z) "${path}" mező értéke nem megengedett: "${String(issue.received)}"`,
        );
        hints.push(
          `a(z) "${path}" mező csak ez lehet: ${issue.options.join(', ')}`,
        );
        break;

      default:
        problems.push(`a(z) "${path}" mezővel gond van: ${issue.message}`);
        hints.push(`nézd meg a(z) "${path}" mezőt`);
    }
  }

  return {
    problem: problems.join('; '),
    hint: hints.join('; '),
  };
}

// ----------------------------------------------------------------------------
// hivas-azonosito a cache-hez
// ----------------------------------------------------------------------------

/**
 * ugyanaz a hivas ugyanazokkal az argumentumokkal ne fusson le ketszer.
 *
 * miert: a kis modellek hajlamosak ismetlesi korbe kerulni. ha ugyanazt
 * kerdezik ujra, es ugyanazt a valaszt kapjak, az megerositi a kort.
 * ha viszont szolunk, hogy "ezt mar lekerdezted", az megtori.
 */
function callKey(toolName: string, args: unknown): string {
  return `${toolName}::${JSON.stringify(args)}`;
}

// ----------------------------------------------------------------------------
// fo vegrehajto
// ----------------------------------------------------------------------------

export type GuardOutcome =
  | { kind: 'ok'; result: ToolResult; forModel: string }
  | { kind: 'nudge'; message: string }
  | { kind: 'give-up'; message: string }
  | { kind: 'needs-confirm'; toolName: string; args: unknown }
  | { kind: 'limit-reached'; message: string };

export interface ExecuteOptions {
  state: ToolLoopState;
  ctx: ToolContext;
  config?: Partial<GuardConfig>;
  /** a felhasznalo mar jovahagyta ezt a hivast */
  confirmed?: boolean;
  /**
   * The tools actually offered to the model in this request. A call to
   * anything else (a disabled category, a tool the router did not select, a
   * hallucinated or injected name) is answered with a nudge and never runs.
   */
  allowedTools?: readonly string[];
}

/**
 * lefuttat egy tool-hivast az osszes vedelemmel egyutt.
 */
export async function executeToolCall(
  toolName: string,
  rawArgs: unknown,
  options: ExecuteOptions,
): Promise<GuardOutcome> {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const { state, ctx } = options;

  // --- 1. letezik-e egyaltalan az eszkoz, es fel volt-e kinalva ---
  const offered = !options.allowedTools || options.allowedTools.includes(toolName);
  const tool = offered ? getTool(toolName) : undefined;

  if (!tool) {
    if (state.nudgesUsed >= config.maxNudges) {
      return {
        kind: 'give-up',
        message: 'Az eszköz nem működött, a válasz enélkül készült.',
      };
    }

    state.nudgesUsed++;

    return {
      kind: 'nudge',
      message: buildNudge(
        toolName,
        'nincs ilyen nevű eszköz ebben a válaszban',
        options.allowedTools && options.allowedTools.length > 0
          ? `csak ezek közül választhatsz: ${options.allowedTools.join(', ')}`
          : 'most nincs elérhető eszköz, válaszolj eszköz nélkül',
      ),
    };
  }

  // --- 2. osszes hivas korlat ---
  if (state.totalCalls >= config.maxToolCallsPerTurn) {
    return {
      kind: 'limit-reached',
      message:
        'Elérted az eszközhívások maximális számát ebben a válaszban. ' +
        'Most válaszolj azzal, amit eddig megtudtál.',
    };
  }

  // --- 3. eszkozonkenti korlat ---
  const usedForThisTool = state.callsPerTool.get(toolName) ?? 0;

  if (usedForThisTool >= tool.maxCallsPerTurn) {
    return {
      kind: 'limit-reached',
      message:
        `A(z) ${toolName} eszközt már ${usedForThisTool} alkalommal használtad ` +
        'ebben a válaszban. Most válaszolj azzal, amit megtudtál.',
    };
  }

  // --- 4. argumentum-validalas ---
  let args: unknown;

  try {
    args = tool.schema.parse(rawArgs);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      return {
        kind: 'give-up',
        message: 'Az eszköz hívása váratlan hibába ütközött.',
      };
    }

    if (state.nudgesUsed >= config.maxNudges) {
      return {
        kind: 'give-up',
        message:
          'Az eszköz nem működött a megadott paraméterekkel, ' +
          'a válasz enélkül készült.',
      };
    }

    state.nudgesUsed++;
    const { problem, hint } = describeZodError(error);

    return { kind: 'nudge', message: buildNudge(toolName, problem, hint) };
  }

  // --- 5. ismetlodo hivas ---
  const key = callKey(toolName, args);
  const cached = state.callCache.get(key);

  if (cached) {
    return {
      kind: 'ok',
      result: cached,
      forModel:
        'Ezt már lekérdezted ebben a válaszban, itt az eredmény újra:\n\n' +
        cached.forModel,
    };
  }

  // --- 6. megerosites destruktiv muveletre ---
  if (tool.destructive && !options.confirmed) {
    return { kind: 'needs-confirm', toolName, args };
  }

  // --- 7. tenyleges vegrehajtas ---
  // (a futasidot minden eszkoz sajat maga meri es teszi a result-ba)
  let result: ToolResult;

  try {
    result = await withDeadline(
      tool.execute(args as never, { ...ctx, confirmed: options.confirmed }),
      config.toolTimeoutMs,
    );
  } catch (error) {
    const message =
      error instanceof ToolTimeoutError
        ? `időtúllépés (${error.message})`
        : error instanceof Error
          ? error.message
          : String(error);

    if (state.nudgesUsed >= config.maxNudges) {
      return {
        kind: 'give-up',
        message: 'Az eszköz nem működött, a válasz enélkül készült.',
      };
    }

    state.nudgesUsed++;

    return {
      kind: 'nudge',
      message: buildNudge(
        toolName,
        `futási hiba: ${message}`,
        'próbáld meg más paraméterekkel, vagy használj másik eszközt',
      ),
    };
  }

  // --- 8. szamlalok frissitese ---
  state.totalCalls++;
  state.callsPerTool.set(toolName, usedForThisTool + 1);
  state.requiredToolsPending = state.requiredToolsPending.filter(
    (name) => name !== toolName,
  );

  // --- 9. az eszkoz sajat hibaja ---
  if (!result.ok) {
    if (state.nudgesUsed >= config.maxNudges) {
      return {
        kind: 'give-up',
        message:
          result.errorForModel ??
          'Az eszköz hibát adott, a válasz enélkül készült.',
      };
    }

    state.nudgesUsed++;

    return {
      kind: 'nudge',
      message: buildNudge(
        toolName,
        result.errorForModel ?? 'az eszköz hibát adott vissza',
        'ellenőrizd a paramétereket és próbáld újra',
      ),
    };
  }

  // sikeres hivas -> cache-eljuk
  state.callCache.set(key, result);

  return { kind: 'ok', result, forModel: result.forModel };
}

// ----------------------------------------------------------------------------
// kotelezo eszkozok kenyszeritese
// ----------------------------------------------------------------------------

/**
 * megnezi, hogy a modell valaszolni akar-e, mielott a kotelezo eszkozoket
 * meghivta volna.
 *
 * ez a "lepeskihagyas" hibamod ellen ved: a router megmondta, hogy ez egy
 * idoben valtozo teny, tehat keresni KELL -- de a modell magabiztosan
 * valaszolna nelkule.
 *
 * legfeljebb EGYSZER kenyszeritunk, kulonben vegtelen korbe kerulhetunk.
 */
export function checkRequiredTools(
  state: ToolLoopState,
): { mustForce: boolean; message?: string } {
  if (state.requiredToolsPending.length === 0) {
    return { mustForce: false };
  }

  if (state.forcedToolReminders >= 1) {
    // mar egyszer szoltunk, tobbszor nem eroltetjuk
    return { mustForce: false };
  }

  state.forcedToolReminders++;

  const names = state.requiredToolsPending.join(', ');

  return {
    mustForce: true,
    message: [
      `Ehhez a kérdéshez kötelező használnod a következő eszközt: ${names}.`,
      'Ne válaszolj addig, amíg le nem futtattad.',
      'Hívd meg most.',
    ].join('\n'),
  };
}

// ----------------------------------------------------------------------------
// statisztika a valaszrol
// ----------------------------------------------------------------------------

export interface LoopSummary {
  totalCalls: number;
  nudgesUsed: number;
  durationMs: number;
  toolsUsed: string[];
  hadForcedTool: boolean;
}

export function summarizeLoop(state: ToolLoopState): LoopSummary {
  return {
    totalCalls: state.totalCalls,
    nudgesUsed: state.nudgesUsed,
    durationMs: Date.now() - state.startedAt,
    toolsUsed: [...state.callsPerTool.keys()],
    hadForcedTool: state.forcedToolReminders > 0,
  };
}
