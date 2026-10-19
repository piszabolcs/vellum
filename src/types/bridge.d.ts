import type { AppSettings, OllamaTestResult } from './settings';

export interface BootstrapData {
  settings: AppSettings;
  appVersion: string;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OllamaStats {
  promptTokens: number;
  evalTokens: number;
  tokensPerSecond: number;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  artifactId?: string;
  error?: string;
}

export interface SourceRef {
  id: string;
  url: string;
  title: string;
}

export interface RouterDecision {
  intent:
    | 'chitchat'
    | 'factual'
    | 'timely'
    | 'reasoning'
    | 'code'
    | 'personal'
    | 'task'
    | 'meta';
  needs_web: boolean;
  needs_memory_search: boolean;
  tool_categories: string[];
  skills: string[];
  complexity: 'low' | 'medium' | 'high';
  thinking: 'off' | 'short' | 'long';
  model_tier: 'small' | 'large';
  language: 'hu' | 'en';
  search_queries_hu: string[];
  search_queries_en: string[];
}

export interface RouteResult {
  decision: RouterDecision;
  source: 'model' | 'fallback' | 'override';
  durationMs: number;
  error?: string;
}

export interface OllamaChatChunk {
  streamId: string;
  contentDelta?: string;
  thinkingDelta?: string;
  searchQuery?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  done: boolean;
}

export interface OllamaChatStreamRequest {
  streamId: string;
  host: string;
  model: string;
  messages: OllamaChatMessage[];
  webSearchEnabled?: boolean;
  contextSize?: number;
  idleTimeoutSec?: number;
  decision?: RouterDecision;
  conversationId?: string | null;
}

export interface OllamaChatStreamResult {
  ok: boolean;
  message: string;
  thinking?: string;
  stats?: OllamaStats;
  searches?: string[];
  contextFallback?: { from: number; to: number };
  toolCalls?: ToolCallRecord[];
  sources?: SourceRef[];
  /** F11: ha több válaszból választottunk, itt van a választás naplója */
  selfConsistency?: { runs: number; chosen: number; reason: string | null };
}

export interface GpuInfo {
  memoryUsedMb: number;
  memoryTotalMb: number;
  utilizationPercent: number;
  temperatureC: number;
}

export interface RamInfo {
  usedMb: number;
  totalMb: number;
}

// --- F3: memoria ---

export type MemoryEntryType = 'fact' | 'person' | 'project' | 'preference' | 'style';

export interface MemoryEntry {
  id: string;
  type: MemoryEntryType;
  content: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  source: 'manual' | 'learned' | 'imported';
  confidence: number;
  enabled: boolean;
  tags: string[];
}

export interface MemoryCandidate {
  id: string;
  type: MemoryEntryType;
  content: string;
  confidence: number;
  proposedAt: number;
  fromConversationId: string | null;
}

export interface MemoryUpsertInput {
  id?: string;
  type: MemoryEntryType;
  content: string;
  priority?: number;
  expiresAt?: number | null;
  enabled?: boolean;
  tags?: string[];
}

export interface MemoryPromptBlocks {
  dataFrame: string;
  instructions: string;
  droppedCount: number;
  estimatedTokens: number;
}

export interface MemoryEstimate {
  tokens: number;
  entryCount: number;
  warn: boolean;
  overHardLimit: boolean;
}

// --- F4: beszelgetesek ---

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  messageCount: number;
  archived: boolean;
  summary: string | null;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking: string | null;
  createdAt: number;
  tokenCount: number | null;
  isError: boolean;
  meta: unknown;
}

export interface ToolConfirmRequest {
  /** ezzel válaszolunk vissza a mainnek */
  callId: string;
  streamId: string;
  toolName: string;
  args: unknown;
}

export interface ConversationSearchResult {
  conversation: Conversation;
  snippet: string;
  messageId: string;
  createdAt: number;
}

export interface IndexerStatus {
  queueLength: number;
  running: boolean;
  paused: boolean;
  processed: number;
  failed: number;
  chunksCreated: number;
  currentJob: string | null;
}

// --- F5: artifactok ---

export interface Artifact {
  id: string;
  kind: 'websearch' | 'webpage' | 'file' | 'tool_output';
  title: string | null;
  url: string | null;
  summary: string;
  body: string;
  createdAt: number;
  conversationId: string | null;
  bytes: number;
}

// --- F6: eszkozok ---

export interface ToolSummary {
  name: string;
  category: string;
  shortDescription: string;
  destructive: boolean;
  needsNetwork: boolean;
}

// --- F9: skillek ---

export interface SkillMeta {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
  path: string;
  estimatedTokens: number;
  enabled: boolean;
  error?: string;
}

export interface LoadSkillResult {
  ok: boolean;
  content?: string;
  tokenCount?: number;
  error?: string;
}

// --- F1: diagnosztika ---

export interface DiagnosticSuggestion {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  command?: string;
}

export interface DiagnosticsResult {
  ollamaReachable: boolean;
  ollamaVersion: string | null;
  loadedModels: {
    name: string;
    sizeBytes: number;
    processor: string;
    gpuPercent: number | null;
    until: string;
  }[];
  envVars: {
    OLLAMA_KEEP_ALIVE: string | null;
    OLLAMA_KV_CACHE_TYPE: string | null;
    OLLAMA_FLASH_ATTENTION: string | null;
  };
  suggestions: DiagnosticSuggestion[];
  rawText: string;
}

export interface ModelStatus {
  activeModel: string | null;
  state: 'idle' | 'loading' | 'ready' | 'error';
  loadingStartedAt: number | null;
  error: string | null;
  chatInProgress: boolean;
}

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  embedding: boolean;
}

export type ModelOpError = 'unreachable' | 'notFound' | 'busy' | 'cancelled' | 'failed';

export interface ModelOpResult {
  ok: boolean;
  error?: ModelOpError;
  detail?: string;
}

export interface InstalledModelsResult extends ModelOpResult {
  models: InstalledModel[];
}

export interface PullProgress {
  tag: string;
  status: string;
  completedBytes: number;
  totalBytes: number;
}

export interface CompanionBridge {
  getBootstrap(): Promise<BootstrapData>;
  updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void;

  /** F6: a main megkérdezi, lefuthat-e egy destruktív eszközhívás */
  onToolConfirmRequest(callback: (request: ToolConfirmRequest) => void): () => void;
  confirmTool(callId: string, approved: boolean): void;
  onNotice(callback: (message: string) => void): () => void;
  setExpanded(expanded: boolean): Promise<void>;
  hideWindow(): void;
  minimizeWindow(): void;
  toggleMaximize(): void;
  quitApp(): void;
  ollamaChatStream(
    request: OllamaChatStreamRequest,
    onChunk: (chunk: OllamaChatChunk) => void
  ): Promise<OllamaChatStreamResult>;
  testOllama(host: string, model: string): Promise<OllamaTestResult>;
  listModels(host: string): Promise<string[]>;
  queryGpu(): Promise<GpuInfo | null>;
  queryRam(): Promise<RamInfo>;

  diagnostics: {
    run(): Promise<DiagnosticsResult>;
  };

  memory: {
    list(): Promise<MemoryEntry[]>;
    upsert(input: MemoryUpsertInput): Promise<MemoryEntry>;
    remove(id: string): Promise<boolean>;
    candidates(): Promise<MemoryCandidate[]>;
    acceptCandidate(id: string, overrides?: Partial<MemoryUpsertInput>): Promise<MemoryEntry | null>;
    rejectCandidate(id: string): Promise<boolean>;
    rawGet(): Promise<string>;
    rawSet(json: string): Promise<{ ok: boolean; error?: string }>;
    estimate(): Promise<MemoryEstimate>;
    buildPrompt(): Promise<MemoryPromptBlocks>;
  };

  conversations: {
    list(opts?: { limit?: number; offset?: number; includeArchived?: boolean }): Promise<Conversation[]>;
    get(id: string): Promise<Conversation | null>;
    create(): Promise<Conversation | null>;
    rename(id: string, title: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    archive(id: string, archived: boolean): Promise<boolean>;
    export(id: string): Promise<string | null>;
    search(query: string, limit?: number): Promise<ConversationSearchResult[]>;
    /** elágaztatás: a megadott üzenetig másolja az előzményt egy új szálba */
    fork(sourceId: string, uptoMessageId?: string): Promise<Conversation | null>;
    generateTitle(
      id: string,
      force?: boolean
    ): Promise<{ ok: boolean; title?: string; error?: string }>;
    messages(conversationId: string): Promise<StoredMessage[]>;
    appendMessage(input: {
      conversationId: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      thinking?: string | null;
      isError?: boolean;
      meta?: unknown;
    }): Promise<StoredMessage | null>;
    updateMessage(id: string, updates: unknown): Promise<boolean>;
  };

  index: {
    status(): Promise<IndexerStatus>;
    enqueue(
      messageId: string,
      conversationId: string,
      content: string,
      role: 'user' | 'assistant'
    ): Promise<void>;
    rebuild(): Promise<{ ok: boolean; indexed: number; error?: string }>;
  };

  artifacts: {
    get(id: string): Promise<Artifact | null>;
    list(conversationId: string): Promise<Artifact[]>;
  };

  compaction: {
    run(conversationId: string): Promise<{ ok: boolean; summaryText?: string; error?: string }>;
  };

  tools: {
    list(): Promise<ToolSummary[]>;
    catalog(): Promise<string>;
    pickFilesRoot(): Promise<string | null>;
  };

  router: {
    route(input: {
      currentMessage: string;
      recentHistory?: { role: string; content: string }[];
      conversationId?: string | null;
    }): Promise<RouteResult | null>;
    log(limit?: number): Promise<unknown[]>;
    modelStatus(): Promise<ModelStatus>;
    /** betölteti a modellt, hogy az első kérdés ne a hidegindulásra várjon */
    preload(model?: string): Promise<{ ok: boolean; model: string; durationMs: number }>;
  };

  skills: {
    list(): Promise<SkillMeta[]>;
    load(name: string): Promise<LoadSkillResult>;
    catalog(): Promise<string>;
    reload(): Promise<SkillMeta[]>;
    create(name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    openFolder(): Promise<void>;
  };

  models: {
    installed(): Promise<InstalledModelsResult>;
    remove(tag: string): Promise<ModelOpResult>;
    pull(tag: string, onProgress: (progress: PullProgress) => void): Promise<ModelOpResult>;
    cancelPull(tag: string): Promise<boolean>;
  };
}

declare global {
  interface Window {
    /** Az Electron preload altal kitett hid. Bongeszos dev modban undefined. */
    companion?: CompanionBridge;
  }
}

export {};
