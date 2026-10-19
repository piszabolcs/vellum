import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPullTracker, deleteModel, listInstalledModels, parseTagsResponse, pullModel } from './modelLibrary';
import { isModelTag, type PullProgress } from './shared';

const HOST = 'http://127.0.0.1:11434';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A streamed response whose body arrives in the given pieces (lines may be cut). */
function streamed(pieces: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      }
    }),
    { status: 200 }
  );
}

describe('isModelTag', () => {
  it('accepts Ollama model references', () => {
    for (const tag of ['qwen3:8b', 'bge-m3', 'qwen3:30b-a3b', 'library/llama3.2:1b', 'hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M']) {
      expect(isModelTag(tag), tag).toBe(true);
    }
  });

  it('rejects anything that is not a plain tag', () => {
    for (const tag of ['', ' qwen3', 'qwen3 8b', '../etc', 'a:b:c', 'http://evil/x', '-rf', 'a/b/c/d', 'x'.repeat(201), 42, null]) {
      expect(isModelTag(tag), String(tag)).toBe(false);
    }
  });
});

describe('parseTagsResponse', () => {
  it('flattens /api/tags and flags embedding models', () => {
    const models = parseTagsResponse({
      models: [
        { name: 'qwen3:8b', size: 5_200_000_000, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
        { name: 'bge-m3:latest', size: 1_200_000_000, details: { family: 'bert', families: ['bert'] } },
        { size: 1 }
      ]
    });
    expect(models).toEqual([
      { name: 'bge-m3:latest', sizeBytes: 1_200_000_000, family: 'bert', parameterSize: null, quantization: null, embedding: true },
      { name: 'qwen3:8b', sizeBytes: 5_200_000_000, family: 'qwen3', parameterSize: '8.2B', quantization: 'Q4_K_M', embedding: false }
    ]);
    expect(parseTagsResponse('garbage')).toEqual([]);
  });
});

describe('createPullTracker', () => {
  it('sums the layers so progress never jumps back at a new layer', () => {
    const tracker = createPullTracker('qwen3:8b');
    tracker.apply({ status: 'pulling manifest' });
    tracker.apply({ status: 'pulling aaa', digest: 'aaa', total: 1000, completed: 1000 });
    const progress = tracker.apply({ status: 'pulling bbb', digest: 'bbb', total: 100, completed: 50 });
    expect(progress).toEqual({ tag: 'qwen3:8b', status: 'pulling bbb', completedBytes: 1050, totalBytes: 1100 });
  });
});

describe('pullModel', () => {
  it('posts to the configured host, streams progress and resolves on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamed([
        '{"status":"pulling manifest"}\n{"status":"pulling aaa","digest":"aaa","tot',
        'al":200,"completed":100}\n{"status":"pulling aaa","digest":"aaa","total":200,"completed":200}\n',
        '{"status":"verifying sha256 digest"}\n{"status":"success"}\n'
      ])
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: PullProgress[] = [];
    const result = await pullModel(HOST, 'qwen3:8b', new AbortController().signal, (p) => seen.push(p));

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${HOST}/api/pull`);
    expect(JSON.parse(init.body)).toMatchObject({ name: 'qwen3:8b', stream: true });
    expect(seen.some((p) => p.totalBytes === 200)).toBe(true);
    expect(seen[seen.length - 1].status).toBe('success');
  });

  it('turns an error line into a "not found" result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      streamed(['{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n'])
    ));
    const result = await pullModel(HOST, 'nope:1b', new AbortController().signal, () => undefined);
    expect(result).toEqual({ ok: false, error: 'notFound', detail: 'pull model manifest: file does not exist' });
  });

  it('reports cancelled when the signal aborts', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    ));
    const controller = new AbortController();
    const pending = pullModel(HOST, 'qwen3:8b', controller.signal, () => undefined);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'cancelled' });
  });
});

describe('deleteModel and listInstalledModels', () => {
  it('sends DELETE /api/delete with the name and maps 404 to "not found"', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"model not found"}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await deleteModel(HOST, 'qwen3:8b');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${HOST}/api/delete`);
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'qwen3:8b' });
    expect(result).toMatchObject({ ok: false, error: 'notFound' });
  });

  it('reports an unreachable host instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await listInstalledModels(HOST)).toEqual({ ok: false, error: 'unreachable', models: [] });
  });
});
