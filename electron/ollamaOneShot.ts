// ============================================================================
// vellum - ollamaOneShot.ts
// ============================================================================
// egyszeri, nem streamelt hivas az ollama /api/chat vegpontjara.
//
// miert kell kulon a streamelt valtozattol: itt nem elo szoveget varunk a
// felhasznalonak, hanem egy gepi feldolgozasra szant json-t. nincs streaming,
// nincs gondolkodas megjelenites, csak egy valasz, amit parse-olunk.
//
// A LENYEG: a `format` parameterrel atadott json schema-bol az ollama grammart
// fordit, es minden szabalysertő token valoszinuseget nullazza. igy a rossz
// formatum nem "ritka", hanem FIZIKAILAG LEHETETLEN.
//
// ezen a fuggvenyen all vagy bukik a router, a memoria-tanulas, a compaction
// es a tool-argumentumok kenyszeritese.
// ============================================================================

import type { OllamaMessage } from './shared';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface OneShotOptions {
  host: string;
  model: string;
  messages: OllamaMessage[];
  /** json schema, zod-bol generalva. ezt kapja az ollama a format mezoben */
  schema: Record<string, unknown>;
  numCtx: number;
  /** alap: 0. itt nem kreativitas kell, hanem determinizmus */
  temperature?: number;
  /** alap: false. lasd a megjegyzest lent a thinking-rol */
  think?: boolean;
  /** alap: 60000 */
  timeoutMs?: number;
  /** ha true, egy javito kort engedunk sema-hiba eseten. alap: true */
  allowRetry?: boolean;
}

export interface OneShotResult<T> {
  ok: boolean;
  data?: T;
  /** a nyers valasz szovege, hibakereseshez */
  raw: string;
  error?: string;
  durationMs: number;
  promptTokens?: number;
  responseTokens?: number;
  /** hany kort futott (1 = elsore sikerult, 2 = kellett javito kor) */
  attempts: number;
}

/** a validalo fuggveny tipusa. jellemzoen egy zod sema .parse metodusa */
export type Validator<T> = (value: unknown) => T;

// ----------------------------------------------------------------------------
// segedfuggvenyek
// ----------------------------------------------------------------------------

/**
 * kiszedi a json-t a valaszbol.
 *
 * elmeletileg a grammar-kenyszerites miatt tiszta json-t kapunk, de a
 * gyakorlatban elofordul, hogy a modell markdown kodblokkba teszi, vagy
 * ele-moge ir valamit. ezert van ez a mentoov.
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim();

  // ha markdown kodblokkban jott, szedjuk ki belole
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }

  // ha a szoveg kozott van egy json objektum, keressuk meg az elso { -tol
  // az utolso } -ig terjedo reszt
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

/**
 * a javito uzenet, amit sema-hiba eseten visszakuldunk a modellnek.
 * konkret, nem altalanos: leirja, mi volt a baj.
 */
function buildSchemaFixMessage(error: string, raw: string): OllamaMessage {
  // a nyers valaszt levagjuk, nehogy megtoltse a kontextust
  const shortRaw = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;

  return {
    role: 'user',
    content: [
      'A válaszod nem felelt meg a megadott JSON sémának.',
      `A hiba: ${error}`,
      `Amit küldtél: ${shortRaw}`,
      'Küldd újra, kizárólag a sémának megfelelő JSON objektumot,',
      'magyarázat és kódblokk-jelölés nélkül.',
    ].join('\n'),
  };
}

/**
 * emlekezteto a promptba, hogy json-t varunk.
 *
 * ez akkor is kell, ha a format parametert hasznaljuk. nelkule egyes
 * modellek vegtelen whitespace-t generalnak, mert nem tudjak, mit kezdjenek
 * a grammar-korlattal.
 */
const JSON_REMINDER =
  'Válaszolj kizárólag egyetlen JSON objektummal, a megadott séma szerint. ' +
  'Ne írj magyarázatot, ne használj markdown kódblokkot.';

// ----------------------------------------------------------------------------
// fo fuggveny
// ----------------------------------------------------------------------------

/**
 * lefuttat egy sema-kenyszeritett hivast, es visszaadja a tipizalt eredmenyt.
 *
 * hibakezeles: soha nem dob kivetelt es soha nem akad el vegtelen korben.
 * ha nem sikerul, ok:false-szal ter vissza, es a hivo fel dont, mit csinal.
 * a routernel peldaul ilyenkor a biztonsagos fallback lep eletbe.
 */
export async function ollamaOneShot<T>(
  opts: OneShotOptions,
  validate: Validator<T>,
): Promise<OneShotResult<T>> {
  const startedAt = Date.now();

  const temperature = opts.temperature ?? 0;
  const think = opts.think ?? false;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const allowRetry = opts.allowRetry ?? true;

  // a json emlekezteto bekerul az utolso uzenet vegere
  const messages: OllamaMessage[] = opts.messages.map((m) => ({ ...m }));
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    last.content = `${last.content}\n\n${JSON_REMINDER}`;
  }

  let lastRaw = '';
  let lastError = '';
  const maxAttempts = allowRetry ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${opts.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          stream: false,
          format: opts.schema,
          think,
          options: {
            temperature,
            num_ctx: opts.numCtx,
          },
        }),
      });

      clearTimeout(timer);

      if (!response.ok) {
        const body = await response.text();
        lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
        // http hiba eseten nincs ertelme javito kort futtatni
        break;
      }

      const payload = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };

      lastRaw = payload.message?.content ?? '';

      // parse es validalas
      try {
        const jsonText = extractJson(lastRaw);
        const parsed: unknown = JSON.parse(jsonText);
        const data = validate(parsed);

        return {
          ok: true,
          data,
          raw: lastRaw,
          durationMs: Date.now() - startedAt,
          promptTokens: payload.prompt_eval_count,
          responseTokens: payload.eval_count,
          attempts: attempt,
        };
      } catch (validationError) {
        lastError =
          validationError instanceof Error
            ? validationError.message
            : String(validationError);

        // ha van meg kor, fuzzuk hozza a javito uzenetet es probaljuk ujra
        if (attempt < maxAttempts) {
          messages.push({ role: 'assistant', content: lastRaw });
          messages.push(buildSchemaFixMessage(lastError, lastRaw));
          continue;
        }
      }
    } catch (networkError) {
      clearTimeout(timer);

      const isAbort =
        networkError instanceof Error && networkError.name === 'AbortError';

      lastError = isAbort
        ? `idotullepes (${timeoutMs} ms)`
        : networkError instanceof Error
          ? networkError.message
          : String(networkError);

      // halozati hiba vagy timeout eseten nincs ertelme ujraprobalni
      break;
    }
  }

  return {
    ok: false,
    raw: lastRaw,
    error: lastError,
    durationMs: Date.now() - startedAt,
    attempts: maxAttempts,
  };
}

// ----------------------------------------------------------------------------
// kenyelmi wrapper
// ----------------------------------------------------------------------------

/**
 * egyszerusitett hivas, ha csak egy system + egy user uzenet kell.
 * a segedhivasok (router, memoria, compaction) tobbsege igy nez ki.
 */
export async function oneShotSimple<T>(
  opts: {
    host: string;
    model: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    numCtx: number;
    timeoutMs?: number;
    think?: boolean;
  },
  validate: Validator<T>,
): Promise<OneShotResult<T>> {
  return ollamaOneShot<T>(
    {
      host: opts.host,
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      schema: opts.schema,
      numCtx: opts.numCtx,
      timeoutMs: opts.timeoutMs,
      think: opts.think,
    },
    validate,
  );
}
