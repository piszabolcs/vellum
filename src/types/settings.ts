export type Language = 'hu' | 'en';

export type BubbleCorner = 'bottom-right' | 'bottom-left';

/** Melyik "borben" fut az app: buborek/messenger vagy nagy, asztali ablak. */
export type Layout = 'bubble' | 'desktop';

/** Valaszthato Ollama kontextusmeretek (num_ctx). A fallback-letra is ezt hasznalja. */
export const CONTEXT_SIZE_OPTIONS = [8192, 16384, 32768, 65536] as const;

/**
 * A renderer-oldali beallitas-tipus.
 *
 * FONTOS: ennek egyeznie kell az electron/shared.ts AppSettings tipusaval.
 * A projekt bevett mintaja, hogy a ket oldal kulon tipusmasolatot tart
 * (nincs kozos import a main es a renderer kozott) -- ha itt bovitesz,
 * a shared.ts-ben is bovitsd.
 */
export interface AppSettings {
  // --- megjelenes es ablak ---
  alwaysOnTop: boolean;
  startWithWindows: boolean;
  language: Language;
  largeText: boolean;
  highContrast: boolean;
  bubbleCorner: BubbleCorner;
  layout: Layout;

  // --- ollama kapcsolat ---
  ollamaHost: string;
  ollamaModel: string;
  ollamaContextSize: number;
  ollamaIdleTimeoutSec: number;
  webSearchEnabled: boolean;
  darkPersona: boolean;

  // --- F1: mag-infrastruktura ---
  thinkingBudgetTokens: number;
  helperModel: string;

  // --- F4: perzisztencia es vektor ---
  embeddingModel: string;
  chunkSizeTokens: number;
  chunkOverlapTokens: number;

  // --- F5: kontextus-menedzsment ---
  compactionEnabled: boolean;
  compactionThreshold: number;
  keepRecentMessages: number;
  offloadThresholdTokens: number;

  // --- F6: eszkozok ---
  filesRootPath: string;
  maxToolCallsPerTurn: number;
  maxNudges: number;
  enabledToolCategories: string[];

  // --- F7: router ---
  routerEnabled: boolean;
  routerTimeoutMs: number;
  largeModelEnabled: boolean;
  largeModelName: string;
  showRouterDecision: boolean;
  englishSearchQueries: boolean;

  // --- F8: melykereses ---
  deepSearchEnabled: boolean;
  maxPagesToFetch: number;
  rerankEnabled: boolean;
  respectRobotsTxt: boolean;

  // --- F9: skillek ---
  skillsEnabled: boolean;
  maxSkillsPerTurn: number;

  // --- F11: kiegeszitok ---
  globalHotkey: string;
  /** F11: tobb valasz generalasa nehez kerdesnel, majd a legjobb kivalasztasa */
  selfConsistencyEnabled: boolean;
  selfConsistencyK: number;
}

export interface OllamaTestResult {
  ok: boolean;
  message: string;
  /** the Ollama API answered (the model itself may still be missing) */
  reachable?: boolean;
}
