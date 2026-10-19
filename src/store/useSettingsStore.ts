import { create } from 'zustand';
import type { AppSettings } from '../types/settings';

interface SettingsState {
  settings: AppSettings;
  appVersion: string;
  loaded: boolean;
  bootstrap: () => Promise<void>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
}

// Csak akkor jut szerephez, ha nincs Electron híd (böngészős dev mód) — az éles
// értékeket a bootstrap hozza. Az `electron/shared.ts` DEFAULT_SETTINGS tükre;
// ha ott új mező kerül be, ide is fel kell venni (a fordító szól, ha kimarad).
const FALLBACK_SETTINGS: AppSettings = {
  // megjelenés és ablak
  alwaysOnTop: true,
  startWithWindows: false,
  language: 'en',
  largeText: false,
  highContrast: false,
  bubbleCorner: 'bottom-right',
  layout: 'bubble',

  // ollama kapcsolat
  ollamaHost: 'http://localhost:11434',
  ollamaModel: 'qwen3:30b-a3b-q4_K_M',
  ollamaContextSize: 32768,
  ollamaIdleTimeoutSec: 600,
  webSearchEnabled: true,
  darkPersona: false,

  // F1: mag-infrastruktúra
  thinkingBudgetTokens: 2000,
  helperModel: '',

  // F4: perzisztencia és vektor
  embeddingModel: 'bge-m3',
  chunkSizeTokens: 512,
  chunkOverlapTokens: 64,

  // F5: kontextus-menedzsment
  compactionEnabled: true,
  compactionThreshold: 0.75,
  keepRecentMessages: 6,
  offloadThresholdTokens: 600,

  // F6: eszközök
  filesRootPath: '',
  maxToolCallsPerTurn: 6,
  maxNudges: 2,
  enabledToolCategories: [
    'search',
    'memory',
    'compute',
    'time',
    'files',
    'artifacts',
    'skills'
  ],

  // F7: router
  routerEnabled: true,
  routerTimeoutMs: 15000,
  largeModelEnabled: false,
  largeModelName: 'qwen3:30b-a3b-q4_K_M',
  showRouterDecision: true,
  englishSearchQueries: true,

  // F8: mélykeresés
  deepSearchEnabled: true,
  maxPagesToFetch: 4,
  rerankEnabled: true,
  respectRobotsTxt: true,

  // F9: skillek
  skillsEnabled: true,
  maxSkillsPerTurn: 2,

  // F11: kiegészítők
  globalHotkey: 'Ctrl+Shift+Space',
  selfConsistencyEnabled: false,
  selfConsistencyK: 3
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: FALLBACK_SETTINGS,
  appVersion: '',
  loaded: false,

  bootstrap: async () => {
    // Böngészős dev módban (Electron nélkül) fallback értékekkel fut.
    if (!window.companion) {
      set({ loaded: true });
      return;
    }
    const data = await window.companion.getBootstrap();
    set({ settings: data.settings, appVersion: data.appVersion, loaded: true });
    window.companion.onSettingsChanged((settings) => set({ settings }));
  },

  updateSettings: async (partial) => {
    if (window.companion) {
      const settings = await window.companion.updateSettings(partial);
      set({ settings });
    } else {
      set((state) => ({ settings: { ...state.settings, ...partial } }));
    }
  }
}));
