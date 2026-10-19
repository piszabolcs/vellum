// ============================================================================
// vellum - ollama.ts (F1 + F6 atirva)
// ============================================================================
// a streamelt chat es a tool-loop.
//
// MI VALTOZOTT AZ EGYESITESKOR:
//   - a regi, kezzel irt "max 2 kereses" tool-loop helyere a guardrail-reteg
//     kerult (tools/guard.ts): sema-validacio, celzott javito kor (nudge),
//     lepesszamlalo, ismetlodo hivas cache-elese
//   - az eszkozok mar nem be vannak egetve, hanem a registry-bol jonnek,
//     a router altal valasztott kategoriak alapjan, kemeny 8-as korlattal
//   - uj: gondolkodasi keret (thinking budget) es ismetlesérzekeles
//
// AMI SZANDEKOSAN VALTOZATLAN (a mukodo appbol orokolt viselkedes):
//   - a tetlensegi idokorlat (nem a valasz hosszara vonatkozik)
//   - a kontextus-fallback letra memoriahibanal
//   - az utolso korben NINCS eszkoz, tehat a modellnek valaszolnia KELL
//   - a vegleges szoveget a valasz adja, nem a delta-akkumulacio
// ============================================================================

import {
  CONTEXT_SIZE_OPTIONS,
  OllamaChatChunk,
  OllamaChatMessage,
  OllamaChatStreamRequest,
  OllamaChatStreamResult,
  OllamaStats,
  OllamaTestResult,
  OllamaToolCall,
  SourceRef,
  THINKING_BUDGETS,
  ToolCallRecord
} from './shared';
import { estimateTokens } from './tokenizer';
import {
  checkRequiredTools,
  createLoopState,
  executeToolCall,
  summarizeLoop
} from './tools/guard';
import { OllamaToolDefinition, selectTools } from './tools/registry';
import { requiredToolsFrom } from './router';
import { tr } from './i18n';

/** An error whose message is already written for the user (shown as is). */
class OllamaUserError extends Error {}

/**
 * Nem a teljes valasz, hanem a TETLENSEG korlatja: minden beerkezo darab ujrainditja.
 * Egy nagy modell hidegindítasa percekig tarthat, es a tool-loop is tobb kort futtat -
 * egy fix teljes-idokorlat ilyenkor a halado generalast vagna el.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const HEALTHCHECK_TIMEOUT_MS = 6_000;

/** ha nincs router, ennyi kort engedunk (a regi viselkedes 2 volt) */
const DEFAULT_MAX_TOOL_ROUNDS = 6;

export interface ConfirmRequest {
  streamId: string;
  toolName: string;
  args: unknown;
}

/**
 * Megkerdezi a felhasznalot egy destruktiv eszkozhivas elott.
 *
 * Azert kivulrol kapjuk, mert ez a modul nem ismeri az IPC-t: a main.ts koti
 * ossze a rendererrel. Ha nincs beallitva (pl. tesztben), a valasz nem, tehat
 * a destruktiv hivas inkabb kimarad, mint hogy kerdes nelkul lefusson.
 */
export type ConfirmHandler = (request: ConfirmRequest) => Promise<boolean>;

let confirmHandler: ConfirmHandler | null = null;

export function setConfirmHandler(handler: ConfirmHandler | null): void {
  confirmHandler = handler;
}

/**
 * A kerest kiegeszito beallitasok, amiket a main.ts ad at.
 * Azert nincs a kozos tipusban, mert ez SOSEM megy at a preload hidon:
 * a renderer nem allithatja at pl. a fajl-gyokermappat egy chat keressel.
 */
export interface ChatRuntimeSettings {
  filesRootPath: string;
  ollamaHost: string;
  webSearchEnabled: boolean;
  maxToolCallsPerTurn: number;
  maxNudges: number;
  enabledToolCategories: string[];
  thinkingBudgetTokens: number;
}

export interface ChatStreamRequest extends OllamaChatStreamRequest {
  settings?: ChatRuntimeSettings;
}

/**
 * Az Ollama stream NDJSON-t ad: soronkent egy JSON objektum. A halozati darabok
 * viszont barhol elvaghatjak a sort, ezert a felbevagott utolso sort maradekkent
 * visszaadjuk a kovetkezo korre.
 */
export function parseNdjsonLines(buffer: string): { events: unknown[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const events = lines.filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  return { events, remainder };
}

export function computeStats(
  promptEvalCount: number,
  evalCount: number,
  evalDurationNs: number
): OllamaStats {
  const tokensPerSecond = evalDurationNs > 0 ? evalCount / (evalDurationNs / 1e9) : 0;
  return {
    promptTokens: promptEvalCount,
    evalTokens: evalCount,
    tokensPerSecond: Math.round(tokensPerSecond * 10) / 10
  };
}

interface OllamaStreamLine {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface RoundResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  stats?: OllamaStats;
  /** igaz, ha a gondolkodasi keret vagy az ismetlesérzekelo megszakitotta */
  abortedByBudget?: boolean;
}

/**
 * Ismetlesérzekeles: ha az utolso 300 gondolkodasi karakter legalabb haromszor
 * elofordul a teljes gondolkodasban, a modell korbe ragadt.
 *
 * Miert kell: a tetlensegi szamlalo ezt NEM fogja meg, mert a gondolkodasi
 * darabok folyamatosan erkeznek, tehat a szamlalo mindig nullazodik.
 */
function looksRepetitive(thinking: string): boolean {
  if (thinking.length < 900) return false;
  const tail = thinking.slice(-300);
  let count = 0;
  let index = thinking.indexOf(tail);
  while (index !== -1) {
    count++;
    if (count >= 3) return true;
    index = thinking.indexOf(tail, index + 1);
  }
  return false;
}

/** Egy kor: elkuldi a beszelgetest es streameli a valaszt. Nem kezel tool-hivast. */
async function streamOneRound(
  req: ChatStreamRequest,
  messages: OllamaChatMessage[],
  tools: OllamaToolDefinition[] | undefined,
  think: boolean,
  thinkingBudget: number,
  onChunk: (chunk: OllamaChatChunk) => void,
  signal: AbortSignal,
  onActivity: () => void
): Promise<RoundResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    think
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (req.contextSize) body.options = { num_ctx: req.contextSize };

  const res = await fetch(`${req.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new OllamaUserError(tr('chat.modelMissing', { model: req.model }));
    }
    const detail = await res.text();
    throw new OllamaUserError(
      tr('chat.httpError', { status: res.status, detail: detail ? ` (${detail})` : '' })
    );
  }
  if (!res.body) {
    throw new OllamaUserError(tr('chat.noStream'));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const round: RoundResult = { content: '', thinking: '', toolCalls: [] };

  let thinkingTokens = 0;
  let contentStarted = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();

    buffer += decoder.decode(value, { stream: true });
    const parsed = parseNdjsonLines(buffer);
    buffer = parsed.remainder;

    for (const raw of parsed.events) {
      const line = raw as OllamaStreamLine;
      const contentDelta = line.message?.content || undefined;
      const thinkingDelta = line.message?.thinking || undefined;

      if (contentDelta) {
        round.content += contentDelta;
        contentStarted = true;
      }
      if (thinkingDelta) {
        round.thinking += thinkingDelta;
        thinkingTokens += estimateTokens(thinkingDelta);
      }

      if (contentDelta || thinkingDelta) {
        onChunk({ streamId: req.streamId, contentDelta, thinkingDelta, done: false });
      }

      // A tool_calls egyben erkezik (elesben verifikalva), nem deltankent.
      if (line.message?.tool_calls?.length) {
        round.toolCalls.push(...line.message.tool_calls);
      }

      if (line.done) {
        round.stats = computeStats(
          line.prompt_eval_count ?? 0,
          line.eval_count ?? 0,
          line.eval_duration ?? 0
        );
      }
    }

    // --- gondolkodasi keret ---
    // csak akkor szakitunk meg, ha meg NEM kezdett valaszolni: ha mar jon a
    // tartalom, akkor a gondolkodas lezarult, nincs mit menteni
    if (!contentStarted && think) {
      const overBudget = thinkingBudget > 0 && thinkingTokens > thinkingBudget;
      if (overBudget || looksRepetitive(round.thinking)) {
        await reader.cancel().catch(() => undefined);
        round.abortedByBudget = true;
        return round;
      }
    }
  }

  return round;
}

/**
 * Streamelt chat guardrailezett tool-loop-pal.
 *
 * A folyamat:
 *   1. a router dontese alapjan kivalasztjuk az eszkozoket (max 8 sema)
 *   2. korokben hivjuk a modellt
 *   3. tool-hivasnal a guard futtatja: validal, hibanal javito kort ad
 *   4. az utolso korben nincs eszkoz -> valaszolnia kell
 */
export async function ollamaChatStream(
  req: ChatStreamRequest,
  onChunk: (chunk: OllamaChatChunk) => void
): Promise<OllamaChatStreamResult> {
  const controller = new AbortController();
  const idleMs =
    req.idleTimeoutSec === undefined ? DEFAULT_IDLE_TIMEOUT_MS : req.idleTimeoutSec * 1000;

  let idleTimer: ReturnType<typeof setTimeout> | undefined =
    idleMs > 0 ? setTimeout(() => controller.abort(), idleMs) : undefined;

  const keepAlive = () => {
    if (idleMs <= 0) return; // kikapcsolt idokorlat: nincs mit ujrainditani
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };

  const runtime: ChatRuntimeSettings = req.settings ?? {
    filesRootPath: '',
    ollamaHost: req.host,
    webSearchEnabled: req.webSearchEnabled ?? true,
    maxToolCallsPerTurn: DEFAULT_MAX_TOOL_ROUNDS,
    maxNudges: 2,
    enabledToolCategories: ['search', 'memory', 'compute', 'time', 'artifacts', 'skills'],
    thinkingBudgetTokens: 2000
  };

  try {
    const messages: OllamaChatMessage[] = [...req.messages];
    const searches: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const sources: SourceRef[] = [];

    // --- 1. eszkozvalasztas ---
    const required = req.decision ? requiredToolsFrom(req.decision) : [];
    const selected = selectTools({
      categories: req.decision?.tool_categories,
      enabledCategories: runtime.enabledToolCategories,
      offline: !runtime.webSearchEnabled,
      requiredTools: required
    });

    // only what was offered may run: disabled categories, offline mode and the
    // router's choice are enforced here, not just hidden from the prompt
    const allowedTools = selected.tools.map((tool) => tool.name);

    // --- 2. guard allapot egy valaszra ---
    const state = createLoopState(required);
    const ctx = {
      conversationId: req.conversationId ?? null,
      settings: {
        filesRootPath: runtime.filesRootPath,
        ollamaHost: runtime.ollamaHost,
        webSearchEnabled: runtime.webSearchEnabled
      }
    };

    // a gondolkodas merteket a router dontese szabja meg
    const thinkingMode = req.decision?.thinking ?? 'short';
    let think = thinkingMode !== 'off';
    let thinkingBudget = THINKING_BUDGETS[thinkingMode] || runtime.thinkingBudgetTokens;

    const maxRounds = runtime.maxToolCallsPerTurn + 2;
    let last: RoundResult | undefined;

    // --- 3. a loop ---
    for (let round = 0; round < maxRounds; round++) {
      const isLastRound = round === maxRounds - 1;
      // az utolso korben NINCS eszkoz -> valaszolnia KELL
      const tools = isLastRound ? undefined : selected.definitions;

      last = await streamOneRound(
        req,
        messages,
        tools,
        think,
        thinkingBudget,
        onChunk,
        controller.signal,
        keepAlive
      );

      // a gondolkodasi keret atlepese -> ujraindítas gondolkodas nelkul.
      // a masodik kor NEM kap ujabb keretet, tehat nincs vegtelen ciklus.
      if (last.abortedByBudget && think) {
        think = false;
        thinkingBudget = 0;
        onChunk({
          streamId: req.streamId,
          thinkingDelta: tr('chat.thinkingBudget'),
          done: false
        });
        round--; // ez a kor nem szamit, ujraprobaljuk gondolkodas nelkul
        continue;
      }

      const calls = last.toolCalls;

      // --- nincs tool-hivas: kesz a valasz? ---
      if (calls.length === 0) {
        const requiredCheck = checkRequiredTools(state);
        if (requiredCheck.mustForce && requiredCheck.message) {
          // a modell valaszolna, pedig a router kotelezove tett egy eszkozt
          messages.push({ role: 'assistant', content: last.content });
          messages.push({ role: 'user', content: requiredCheck.message });
          continue;
        }
        break;
      }

      // --- tool-hivasok feldolgozasa ---
      messages.push({
        role: 'assistant',
        content: last.content,
        tool_calls: calls
      });

      for (const call of calls) {
        const name = call.function?.name ?? '';
        const args = call.function?.arguments ?? {};

        onChunk({ streamId: req.streamId, toolCall: { name, args }, done: false });

        // a webes keresest kulon jelezzuk, mert a felulet ezt mar mutatja
        if (name === 'web_search' && typeof args.query === 'string') {
          searches.push(args.query);
          onChunk({ streamId: req.streamId, searchQuery: args.query, done: false });
        }

        const guardConfig = {
          maxToolCallsPerTurn: runtime.maxToolCallsPerTurn,
          maxNudges: runtime.maxNudges
        };

        let outcome = await executeToolCall(name, args, {
          state,
          ctx,
          config: guardConfig,
          allowedTools
        });

        // Destruktiv eszkoznel a guard eloszor csak jelez; a felhasznalot mi
        // kerdezzuk meg, es jovahagyas eseten ugyanaz a hivas fut le megegyszer,
        // most mar `confirmed` jelzovel.
        if (outcome.kind === 'needs-confirm') {
          const approved = confirmHandler
            ? await confirmHandler({ streamId: req.streamId, toolName: name, args })
            : false;

          keepAlive(); // a felhasznalo gondolkodasi ideje ne szamitson tetlensegnek

          outcome = approved
            ? await executeToolCall(name, args, {
                state,
                ctx,
                config: guardConfig,
                confirmed: true,
                allowedTools
              })
            : {
                kind: 'give-up',
                message:
                  'A felhasználó nem hagyta jóvá ezt a műveletet, ezért nem futott le. ' +
                  'Folytasd nélküle, és ne kérdezz rá újra.'
              };
        }

        keepAlive(); // egy eszkoz futasa is telhet, ne az utana indulo kor igya meg

        switch (outcome.kind) {
          case 'ok': {
            messages.push({
              role: 'tool',
              content: outcome.forModel,
              tool_name: name
            });
            toolCalls.push({
              name,
              args,
              ok: true,
              durationMs: outcome.result.durationMs,
              artifactId: outcome.result.artifactId
            });
            // a keresesi forrasokat kigyujtjuk a valasz ala
            const data = outcome.result.data as { sources?: SourceRef[] } | undefined;
            if (data?.sources) {
              for (let i = 0; i < data.sources.length; i++) {
                sources.push({
                  id: `F${sources.length + 1}`,
                  url: data.sources[i].url,
                  title: data.sources[i].title
                });
              }
            }
            break;
          }

          case 'nudge':
            // NEM hibabuborek: celzott javito uzenet, a modell kap meg egy kort
            messages.push({ role: 'tool', content: outcome.message, tool_name: name });
            toolCalls.push({ name, args, ok: false, durationMs: 0, error: 'javító kör' });
            break;

          case 'give-up':
          case 'limit-reached':
            messages.push({ role: 'tool', content: outcome.message, tool_name: name });
            toolCalls.push({ name, args, ok: false, durationMs: 0, error: outcome.message });
            break;

          case 'needs-confirm':
            // ide mar nem juthatunk: a megerositest fentebb lekezeltuk. Ha megis,
            // az azt jelenti, hogy a jovahagyott hivas is megerositest kert --
            // ilyenkor inkabb kihagyjuk, mint hogy vegtelen korbe menjunk.
            messages.push({
              role: 'tool',
              content: 'A művelet megerősítést igényel, ezért nem futott le.',
              tool_name: name
            });
            break;
        }
      }
    }

    onChunk({ streamId: req.streamId, done: true });

    const content = last?.content ?? '';
    const thinking = last?.thinking ?? '';

    if (!content && !thinking) {
      return { ok: false, message: tr('chat.empty') };
    }

    const summary = summarizeLoop(state);
    void summary; // a naplozashoz keszult, a valaszban most nem hasznaljuk

    return {
      ok: true,
      message: content,
      thinking: thinking || undefined,
      stats: last?.stats,
      searches: searches.length > 0 ? searches : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      sources: sources.length > 0 ? sources : undefined
    };
  } catch (err) {
    // missing model / HTTP errors are already phrased for the user
    if (err instanceof OllamaUserError) return { ok: false, message: err.message };

    const reason = err instanceof Error ? err.message : String(err);

    // aborted = the model sent nothing for minutes; Ollama itself is running
    if (/abort/i.test(reason)) return { ok: false, message: tr('chat.idleTimeout') };

    // the technical reason ("fetch failed") goes to the log, not to the bubble
    console.warn(`[vellum] Ollama request to ${req.host} failed: ${reason}`);
    return { ok: false, message: tr('chat.unreachable', { host: req.host }) };
  } finally {
    clearTimeout(idleTimer);
  }
}

export async function ollamaHealthCheck(host: string, model: string): Promise<OllamaTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, reachable: true, message: tr('health.httpError', { status: res.status }) };
    }

    const data = (await res.json()) as { models?: { name: string }[] };
    const names = data.models?.map((m) => m.name) ?? [];
    const has = names.some(
      (n) => n === model || n.startsWith(`${model}:`) || n.split(':')[0] === model.split(':')[0]
    );

    if (!has) {
      return { ok: false, reachable: true, message: tr('health.modelMissing', { model }) };
    }
    return { ok: true, reachable: true, message: tr('health.ok', { model }) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reachable: false, message: tr('health.unreachable', { reason }) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function listModels(host: string): Promise<string[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: { name: string }[] };
  return data.models?.map((m) => m.name) ?? [];
}

/**
 * Memoria-kimerulesre utalo Ollama-hibamintak. Elesben merve (30b, 8 GB VRAM +
 * 32 GB RAM): "failed to allocate buffer of size ..." es "unable to allocate
 * CUDA_Host buffer" jon, neha "reported out-of-memory during startup" kiserettel.
 */
const MEMORY_ERROR_PATTERN =
  /out of memory|out-of-memory|requires more system memory|cuda error|failed to allocate|unable to allocate|insufficient memory|not enough memory/i;

export function isMemoryExhaustionError(message: string): boolean {
  return MEMORY_ERROR_PATTERN.test(message);
}

function nextLowerContextSize(current: number): number | undefined {
  const lower = CONTEXT_SIZE_OPTIONS.filter((size) => size < current);
  return lower.length > 0 ? lower[lower.length - 1] : undefined;
}

/**
 * Az ollamaChatStream kore epulo fallback: ha a beallitott kontextusmeret
 * memoria-kimerulesi hibaval bukik, automatikusan ujraprobalja a letra
 * eggyel alacsonyabb fokaval, egeszen a legkisebb CONTEXT_SIZE_OPTIONS
 * ertekig. Sikeres, de leszallitott probalkozasnal a `contextFallback`
 * mezoben jelzi, honnan hova valtott.
 */
export async function ollamaChatStreamWithFallback(
  req: ChatStreamRequest,
  onChunk: (chunk: OllamaChatChunk) => void
): Promise<OllamaChatStreamResult> {
  const startSize = req.contextSize;
  if (startSize === undefined) {
    return ollamaChatStream(req, onChunk);
  }

  let currentSize = startSize;
  for (;;) {
    const result = await ollamaChatStream({ ...req, contextSize: currentSize }, onChunk);
    if (result.ok) {
      return currentSize === startSize
        ? result
        : { ...result, contextFallback: { from: startSize, to: currentSize } };
    }
    if (!isMemoryExhaustionError(result.message)) return result;

    const lower = nextLowerContextSize(currentSize);
    if (lower === undefined) return result;
    currentSize = lower;
  }
}

