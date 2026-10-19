// ============================================================================
// vellum - modelLibrary.ts
// ============================================================================
// The model browser's Ollama calls: list (GET /api/tags), delete
// (DELETE /api/delete) and download (POST /api/pull, NDJSON progress).
// Every call goes to the configured Ollama host only; the caller passes it in
// from the settings, never from the renderer.
// ============================================================================

import { parseNdjsonLines } from './ollama';
import type {
  InstalledModel,
  InstalledModelsResult,
  ModelOpError,
  ModelOpResult,
  PullProgress
} from './shared';

const LIST_TIMEOUT_MS = 5_000;
const DELETE_TIMEOUT_MS = 30_000;
/** the renderer does not need more than ~10 progress updates per second */
const PROGRESS_INTERVAL_MS = 100;

interface TagsEntry {
  name?: unknown;
  size?: unknown;
  details?: {
    family?: unknown;
    families?: unknown;
    parameter_size?: unknown;
    quantization_level?: unknown;
  };
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Flattens the /api/tags answer; entries without a name are dropped. */
export function parseTagsResponse(data: unknown): InstalledModel[] {
  const list = (data as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return (list as TagsEntry[])
    .filter((entry) => typeof entry?.name === 'string')
    .map((entry) => {
      const name = entry.name as string;
      const family = str(entry.details?.family);
      const families = Array.isArray(entry.details?.families) ? (entry.details.families as unknown[]) : [];
      const bert = [family, ...families].some((f) => typeof f === 'string' && f.includes('bert'));
      return {
        name,
        sizeBytes: typeof entry.size === 'number' ? entry.size : 0,
        family,
        parameterSize: str(entry.details?.parameter_size),
        quantization: str(entry.details?.quantization_level),
        embedding: bert || /embed/i.test(name)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function classify(detail: string): ModelOpError {
  return /file does not exist|not found|no such/i.test(detail) ? 'notFound' : 'failed';
}

async function errorFrom(res: Response): Promise<ModelOpResult> {
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    detail = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // plain text answer
  }
  const error = res.status === 404 ? 'notFound' : classify(detail);
  return { ok: false, error, detail: detail.slice(0, 300) || `HTTP ${res.status}` };
}

export async function listInstalledModels(host: string): Promise<InstalledModelsResult> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) return { ...(await errorFrom(res)), models: [] };
    return { ok: true, models: parseTagsResponse(await res.json()) };
  } catch {
    return { ok: false, error: 'unreachable', models: [] };
  }
}

export async function deleteModel(host: string, tag: string): Promise<ModelOpResult> {
  try {
    const res = await fetch(`${host}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // "name" is the documented field, newer servers read "model"
      body: JSON.stringify({ name: tag, model: tag }),
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS)
    });
    return res.ok ? { ok: true } : await errorFrom(res);
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}

interface PullLine {
  status?: unknown;
  digest?: unknown;
  total?: unknown;
  completed?: unknown;
  error?: unknown;
}

/** Sums the per-layer byte counts, so the bar does not jump back at each new layer. */
export function createPullTracker(tag: string) {
  const layers = new Map<string, { total: number; completed: number }>();
  let status = '';
  return {
    apply(line: PullLine): PullProgress {
      if (typeof line.status === 'string') status = line.status;
      if (typeof line.digest === 'string' && typeof line.total === 'number' && line.total > 0) {
        const completed = typeof line.completed === 'number' ? Math.min(line.completed, line.total) : 0;
        layers.set(line.digest, { total: line.total, completed });
      }
      let completedBytes = 0;
      let totalBytes = 0;
      for (const layer of layers.values()) {
        completedBytes += layer.completed;
        totalBytes += layer.total;
      }
      return { tag, status, completedBytes, totalBytes };
    }
  };
}

/**
 * Downloads a model. Resolves when Ollama reports "success", the stream fails
 * or the signal aborts (error: 'cancelled'); it never throws.
 */
export async function pullModel(
  host: string,
  tag: string,
  signal: AbortSignal,
  onProgress: (progress: PullProgress) => void
): Promise<ModelOpResult> {
  const tracker = createPullTracker(tag);
  let lastSent = 0;
  let lastStatus = '';
  let succeeded = false;

  try {
    const res = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tag, model: tag, stream: true }),
      signal
    });
    if (!res.ok) return await errorFrom(res);
    if (!res.body) return { ok: false, error: 'failed', detail: 'no response body' };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseNdjsonLines(buffer);
      buffer = parsed.remainder;
      for (const raw of parsed.events) {
        const line = raw as PullLine;
        if (typeof line.error === 'string') {
          return { ok: false, error: classify(line.error), detail: line.error.slice(0, 300) };
        }
        const progress = tracker.apply(line);
        if (progress.status === 'success') succeeded = true;
        const now = Date.now();
        if (progress.status !== lastStatus || now - lastSent >= PROGRESS_INTERVAL_MS) {
          lastStatus = progress.status;
          lastSent = now;
          onProgress(progress);
        }
      }
    }
    return succeeded ? { ok: true } : { ok: false, error: 'failed', detail: 'the download ended early' };
  } catch (error) {
    if (signal.aborted) return { ok: false, error: 'cancelled' };
    const detail = error instanceof Error ? error.message : String(error);
    // fetch reports a refused or dropped connection as a TypeError
    return { ok: false, error: error instanceof TypeError ? 'unreachable' : 'failed', detail: detail.slice(0, 300) };
  }
}
