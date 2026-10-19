import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeStats,
  isMemoryExhaustionError,
  listModels,
  ollamaChatStream,
  ollamaChatStreamWithFallback,
  ollamaHealthCheck,
  parseNdjsonLines,
  setConfirmHandler
} from './ollama';
import type { OllamaChatChunk } from './shared';
import { z } from 'zod';
import { registerBuiltinTools } from './tools';
import { clearRegistry, registerTool } from './tools/registry';

const HOST = 'http://localhost:11434';
const MODEL = 'qwen3:8b';

afterEach(() => {
  vi.unstubAllGlobals();
  // a registry es a megerosites-kezelo modulszintu, ezert a tesztek kozott
  // vissza kell allitani oket
  clearRegistry();
  setConfirmHandler(null);
});

describe('parseNdjsonLines', () => {
  it('teljes sorokat JSON objektumokká alakítja, a maradékot visszaadja', () => {
    const { events, remainder } = parseNdjsonLines('{"a":1}\n{"b":2}\n{"c"');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(remainder).toBe('{"c"');
  });

  it('üres bemenetre üres eseménylistát és üres maradékot ad', () => {
    const { events, remainder } = parseNdjsonLines('');
    expect(events).toEqual([]);
    expect(remainder).toBe('');
  });

  it('ha nincs lezárt sor, minden a maradékba kerül', () => {
    const { events, remainder } = parseNdjsonLines('{"a":1');
    expect(events).toEqual([]);
    expect(remainder).toBe('{"a":1');
  });
});

describe('computeStats', () => {
  it('kiszámolja a tok/s-et', () => {
    const stats = computeStats(72, 288, 6_516_849_000);
    expect(stats.promptTokens).toBe(72);
    expect(stats.evalTokens).toBe(288);
    expect(stats.tokensPerSecond).toBeCloseTo(44.2, 1);
  });

  it('nulla időtartamnál 0 tok/s-et ad, nem dob hibát', () => {
    const stats = computeStats(10, 5, 0);
    expect(stats.tokensPerSecond).toBe(0);
  });
});

/** Egy komplett, lezárt válaszsor statisztikákkal – a legtöbb teszthez ennyi kell. */
function doneLine(content: string): string {
  return JSON.stringify({
    message: { content },
    done: true,
    prompt_eval_count: 10,
    eval_count: 20,
    eval_duration: 2_000_000_000
  });
}

function fakeBody(lines: string[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i >= lines.length) return { done: true, value: undefined };
        const chunk = new TextEncoder().encode(lines[i] + '\n');
        i += 1;
        return { done: false, value: chunk };
      }
    })
  };
}

describe('ollamaChatStream', () => {
  it('chunk eseményeket küld és a végén statisztikákkal záró eredményt ad', async () => {
    const lines = [
      JSON.stringify({ message: { content: '', thinking: 'Gondolkodom' }, done: false }),
      JSON.stringify({ message: { content: 'Szia', thinking: '' }, done: false }),
      JSON.stringify({ message: { content: '!', thinking: '' }, done: false }),
      JSON.stringify({
        message: { content: '', thinking: '' },
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
        eval_duration: 2_000_000_000
      })
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: fakeBody(lines) }));

    const chunks: OllamaChatChunk[] = [];
    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [] },
      (c) => chunks.push(c)
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Szia!');
    expect(result.thinking).toBe('Gondolkodom');
    expect(result.stats).toEqual({ promptTokens: 10, evalTokens: 20, tokensPerSecond: 10 });
    expect(chunks.some((c) => c.thinkingDelta === 'Gondolkodom')).toBe(true);
    expect(chunks.some((c) => c.contentDelta === 'Szia')).toBe(true);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  it('barátságos hibát ad, ha a modell nincs lehúzva (404)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [] },
      () => {}
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ollama pull');
  });

  it('a hibaüzenetbe belefoglalja az Ollama válasz-törzsét is, ha van', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'model requires more system memory (17.2 GiB) than is available (16.0 GiB)'
    }));

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [] },
      () => {}
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('requires more system memory');
  });

  it('names the host and tells the user what to do on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [] },
      () => {}
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain(HOST);
    expect(result.message).toContain('Retry');
    expect(result.message).not.toContain('ECONNREFUSED');
  });

  it('időtúllépésnél érthető üzenetet ad, nem az Ollama elérhetetlenségét emlegeti', async () => {
    // Így néz ki élesben: a fetch AbortError-t dob, ha lejárt az időkorlát.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('This operation was aborted')));

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [] },
      () => {}
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('idle timeout');
    expect(result.message).not.toContain('Could not reach');
  });

  // Az eszkozok a registry-bol jonnek, nem kozvetlenul a webSearchEnabled
  // kapcsolobol -- a kapcsolo az "offline" jelzot allitja, ami a halozatot
  // igenylo eszkozoket zarja ki. Ezert a beepitett eszkozoket regisztralni
  // kell, kulonben a teszt ures registry-t mer, es hamisan zold lenne.
  function offeredToolNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    return (body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name
    );
  }

  it('nem kínálja a web_search eszközt, ha a webSearchEnabled hamis', async () => {
    registerBuiltinTools();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: false },
      () => {}
    );

    const names = offeredToolNames(fetchMock);
    // ures listan a not.toContain magatol teljesulne -- ezert kikotjuk, hogy
    // a tobbi eszkoz igenis ott van, csak a halozatos maradt ki
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('web_search');
  });

  // --- F6: destruktiv eszkoz megerositese ---

  /** egy kor, amiben a modell meghivja a save_memory-t, majd egy lezaro kor */
  function confirmScenario() {
    const toolCallLine = JSON.stringify({
      message: {
        content: '',
        tool_calls: [
          {
            function: {
              name: 'save_memory',
              arguments: { type: 'fact', content: 'A felhasználó Budapesten él.', confidence: 0.9 }
            }
          }
        ]
      },
      done: true
    });

    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody([toolCallLine]) })
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Megjegyeztem.')]) });
  }

  it('destruktív eszköznél megkérdezi a felhasználót, mielőtt lefuttatná', async () => {
    registerBuiltinTools();
    vi.stubGlobal('fetch', confirmScenario());

    const asked: string[] = [];
    setConfirmHandler(async (request) => {
      asked.push(request.toolName);
      return false; // most ne fusson le
    });

    await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: true },
      () => {}
    );

    expect(asked).toEqual(['save_memory']);
  });

  it('elutasításkor nem futtatja le, és ezt közli a modellel', async () => {
    registerBuiltinTools();
    vi.stubGlobal('fetch', confirmScenario());
    setConfirmHandler(async () => false);

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: true },
      () => {}
    );

    const call = result.toolCalls?.find((c) => c.name === 'save_memory');
    expect(call?.ok).toBe(false);
  });

  it('jóváhagyáskor ugyanaz a hívás lefut', async () => {
    // Sajat teszteszkozt regisztralunk a save_memory helyett: igy a "lefutott-e"
    // kerdesre egyertelmu valaszt kapunk, a memoria-fajl bekotese nelkul.
    let executed = 0;

    clearRegistry();
    registerTool({
      name: 'teszt_iras',
      category: 'compute',
      shortDescription: 'teszt',
      description: 'teszt eszköz a megerősítéshez',
      schema: z.object({}),
      jsonSchema: { type: 'object', properties: {} },
      destructive: true,
      needsNetwork: false,
      maxCallsPerTurn: 2,
      priority: 90,
      async execute() {
        executed += 1;
        return { ok: true, forModel: 'kész', durationMs: 1 };
      }
    });

    const toolCallLine = JSON.stringify({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'teszt_iras', arguments: {} } }]
      },
      done: true
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody([toolCallLine]) })
        .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) })
    );

    setConfirmHandler(async () => true);

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: true },
      () => {}
    );

    expect(executed).toBe(1);
    expect(result.toolCalls?.find((c) => c.name === 'teszt_iras')?.ok).toBe(true);
  });

  it('kezelő nélkül nem fut le a destruktív hívás', async () => {
    // a "nincs kit megkerdezni" eset: inkabb kimarad, mint hogy kerdes nelkul fusson
    registerBuiltinTools();
    vi.stubGlobal('fetch', confirmScenario());
    setConfirmHandler(null);

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: true },
      () => {}
    );

    expect(result.toolCalls?.find((c) => c.name === 'save_memory')?.ok).toBe(false);
  });

  it('kínálja a web_search eszközt, ha a webSearchEnabled igaz', async () => {
    registerBuiltinTools();
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: true },
      () => {}
    );

    expect(offeredToolNames(fetchMock)).toContain('web_search');
  });

  it('num_ctx-et küld, ha contextSize meg van adva', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], contextSize: 16384 },
      () => {}
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toEqual({ num_ctx: 16384 });
  });

  it('nem küld options mezőt, ha nincs contextSize megadva', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream({ streamId: 's1', host: HOST, model: MODEL, messages: [] }, () => {});

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toBeUndefined();
  });
});

describe('ollamaChatStream tool-loop (guardrail)', () => {
  // A regi, beegetett "max 2 kereses" loop helyet a guardrail-reteg vette at:
  // az eszkozok a registry-bol jonnek, a router altal valasztott kategoriak
  // alapjan. Itt azt ellenorizzuk, hogy a loop VAZA helyes marad.

  it('eszkozhivas nelkul egyetlen kor utan lezar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: false },
      () => {}
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Kész');
    // nincs tool-hivas -> nem indul ujabb kor
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a router "off" gondolkodasa eseten think:false megy ki', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Szia')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream(
      {
        streamId: 's1',
        host: HOST,
        model: MODEL,
        messages: [],
        decision: {
          intent: 'chitchat',
          needs_web: false,
          needs_memory_search: false,
          tool_categories: [],
          skills: [],
          complexity: 'low',
          thinking: 'off',
          model_tier: 'small',
          language: 'hu',
          search_queries_hu: [],
          search_queries_en: []
        }
      },
      () => {}
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.think).toBe(false);
  });

  it('never executes a tool from a disabled category, even if the model names it', async () => {
    let executed = 0;
    registerTool({
      name: 'secret_read',
      category: 'files',
      shortDescription: 'test',
      description: 'test tool in the files category',
      schema: z.object({}),
      jsonSchema: { type: 'object', properties: {} },
      destructive: false,
      needsNetwork: false,
      maxCallsPerTurn: 2,
      priority: 90,
      async execute() {
        executed += 1;
        return { ok: true, forModel: 'TOP-SECRET-PAYLOAD', durationMs: 1 };
      }
    });
    const toolCallLine = JSON.stringify({
      message: { content: '', tool_calls: [{ function: { name: 'secret_read', arguments: {} } }] },
      done: true
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody([toolCallLine]) })
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStream(
      {
        streamId: 's1',
        host: HOST,
        model: MODEL,
        messages: [],
        settings: {
          filesRootPath: '',
          ollamaHost: HOST,
          webSearchEnabled: false,
          maxToolCallsPerTurn: 6,
          maxNudges: 2,
          enabledToolCategories: ['compute'],
          thinkingBudgetTokens: 0
        }
      },
      () => {}
    );

    expect(executed).toBe(0);
    expect(result.toolCalls?.[0]).toMatchObject({ name: 'secret_read', ok: false });
    const secondRound = JSON.parse(fetchMock.mock.calls[1][1].body);
    const toolMessage = secondRound.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.content).not.toContain('TOP-SECRET-PAYLOAD');
  });

  it('offline modban a halozatot igenylo eszkozok kimaradnak', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    await ollamaChatStream(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], webSearchEnabled: false },
      () => {}
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const names: string[] = (body.tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name
    );
    expect(names).not.toContain('web_search');
  });
});

describe('ollamaHealthCheck', () => {
  it('ok:true, ha a modell szerepel a lehúzott modellek között', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen3:8b' }, { name: 'llama3:8b' }] })
      })
    );

    const result = await ollamaHealthCheck(HOST, MODEL);

    expect(result.ok).toBe(true);
  });

  it('ok:false, ha a modell nincs a lehúzott modellek között', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'llama3:8b' }] })
      })
    );

    const result = await ollamaHealthCheck(HOST, MODEL);

    expect(result.ok).toBe(false);
    expect(result.message).toContain('ollama pull');
  });

  it('ok:false, ha az Ollama nem érhető el', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await ollamaHealthCheck(HOST, MODEL);

    expect(result.ok).toBe(false);
  });
});

describe('listModels', () => {
  it('visszaadja a lehúzott modellek neveit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen3:30b-a3b-q4_K_M' }, { name: 'llama3:8b' }] })
      })
    );

    const names = await listModels(HOST);

    expect(names).toEqual(['qwen3:30b-a3b-q4_K_M', 'llama3:8b']);
  });

  it('üres listát ad, ha az Ollama hibát ad vissza', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const names = await listModels(HOST);

    expect(names).toEqual([]);
  });
});

describe('isMemoryExhaustionError', () => {
  it('igazat ad memória-kimerülésre utaló hibaüzenetekre', () => {
    expect(isMemoryExhaustionError('CUDA error: out of memory')).toBe(true);
    expect(isMemoryExhaustionError('model requires more system memory than is available')).toBe(true);
    expect(isMemoryExhaustionError('failed to allocate buffer')).toBe(true);
  });

  it('felismeri a 30b-nél élesben kapott Ollama hibaszöveget', () => {
    const real =
      'llama-server reported out-of-memory during startup: ' +
      'ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 13401243648\n' +
      'error loading model: unable to allocate CUDA_Host buffer';
    expect(isMemoryExhaustionError(real)).toBe(true);
  });

  it('hamisat ad más jellegű hibákra', () => {
    expect(isMemoryExhaustionError('Az Ollama HTTP 404 hibát adott vissza.')).toBe(false);
    expect(isMemoryExhaustionError('ECONNREFUSED')).toBe(false);
  });
});

describe('ollamaChatStreamWithFallback', () => {
  it('sikeres első próbálkozásnál nem jelez fallback-et', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStreamWithFallback(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], contextSize: 32768 },
      () => {}
    );

    expect(result.ok).toBe(true);
    expect(result.contextFallback).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('memória-hiba esetén eggyel alacsonyabb kontextussal újrapróbálja, és jelzi a fallback-et', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'model requires more system memory (17.2 GiB) than is available (16.0 GiB)'
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: fakeBody([doneLine('Kész')]) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStreamWithFallback(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], contextSize: 32768 },
      () => {}
    );

    expect(result.ok).toBe(true);
    expect(result.contextFallback).toEqual({ from: 32768, to: 16384 });
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.options).toEqual({ num_ctx: 16384 });
  });

  it('nem-memória hibánál nem próbálkozik újra', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStreamWithFallback(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], contextSize: 32768 },
      () => {}
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a legalacsonyabb fokozaton is elbukva feladja, nem végtelen ciklus', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'CUDA error: out of memory'
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await ollamaChatStreamWithFallback(
      { streamId: 's1', host: HOST, model: MODEL, messages: [], contextSize: 32768 },
      () => {}
    );

    expect(result.ok).toBe(false);
    // 32768 -> 16384 -> 8192 -> nincs lejjebb: 3 próbálkozás
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
