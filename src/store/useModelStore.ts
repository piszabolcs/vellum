import { create } from 'zustand';
import type { InstalledModel, ModelOpError } from '../types/bridge';

export interface DownloadState {
  tag: string;
  phase: 'running' | 'done' | 'error';
  status: string;
  completedBytes: number;
  totalBytes: number;
  error?: ModelOpError;
  detail?: string;
}

interface ModelState {
  installed: InstalledModel[];
  loading: boolean;
  listError: ModelOpError | null;
  /** the current or last download; lives here so closing the window does not lose it */
  download: DownloadState | null;
  refresh: () => Promise<void>;
  remove: (tag: string) => Promise<{ ok: boolean; error?: ModelOpError; detail?: string }>;
  startDownload: (tag: string) => Promise<void>;
  cancelDownload: () => void;
  dismissDownload: () => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
  installed: [],
  loading: false,
  listError: null,
  download: null,

  refresh: async () => {
    if (!window.companion) return;
    set({ loading: true });
    const result = await window.companion.models
      .installed()
      .catch(() => ({ ok: false, error: 'unreachable' as const, models: [] }));
    set({ installed: result.models, listError: result.ok ? null : result.error ?? 'failed', loading: false });
  },

  remove: async (tag) => {
    const result = await window.companion?.models
      .remove(tag)
      .catch(() => ({ ok: false, error: 'failed' as const }));
    await get().refresh();
    return result ?? { ok: false, error: 'unreachable' };
  },

  startDownload: async (tag) => {
    if (!window.companion || get().download?.phase === 'running') return;
    set({ download: { tag, phase: 'running', status: '', completedBytes: 0, totalBytes: 0 } });
    const result = await window.companion.models
      .pull(tag, (progress) => {
        const current = get().download;
        if (current?.tag === tag && current.phase === 'running') set({ download: { ...current, ...progress } });
      })
      .catch(() => ({ ok: false, error: 'failed' as const, detail: undefined }));
    const current = get().download;
    if (current?.tag !== tag) return;
    if (result.ok) {
      set({ download: { ...current, phase: 'done' } });
      await get().refresh();
    } else if (result.error === 'cancelled') {
      set({ download: null });
    } else {
      set({ download: { ...current, phase: 'error', error: result.error ?? 'failed', detail: result.detail } });
    }
  },

  cancelDownload: () => {
    const current = get().download;
    if (current?.phase === 'running') void window.companion?.models.cancelPull(current.tag);
  },

  dismissDownload: () => set({ download: null })
}));
