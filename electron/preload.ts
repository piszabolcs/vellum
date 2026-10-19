import { contextBridge, ipcRenderer } from 'electron';
import {
  AppSettings,
  BootstrapData,
  GpuInfo,
  InstalledModelsResult,
  IPC,
  ModelOpResult,
  OllamaChatChunk,
  OllamaChatStreamRequest,
  OllamaChatStreamResult,
  OllamaTestResult,
  PullProgress,
  RamInfo
} from './shared';

// A renderer csak ezen a szuk, tipusos hidon keresztul eri el a main processt.
//
// SZERKEZET: az F3-F9 csatornak temank szerint csoportositva vannak
// (memory, conversations, index, artifacts, tools, router, skills, diagnostics),
// mert lapos listaban 50+ metodus attekinthetetlen lenne.
const companionBridge = {
  getBootstrap: (): Promise<BootstrapData> => ipcRenderer.invoke(IPC.GET_BOOTSTRAP),

  updateSettings: (partial: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.UPDATE_SETTINGS, partial),

  onSettingsChanged: (callback: (settings: AppSettings) => void): (() => void) => {
    const listener = (_event: unknown, settings: AppSettings) => callback(settings);
    ipcRenderer.on(IPC.SETTINGS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.SETTINGS_CHANGED, listener);
  },

  // --- F6: destruktiv eszkoz megerositese ---
  onToolConfirmRequest: (
    callback: (request: {
      callId: string;
      streamId: string;
      toolName: string;
      args: unknown;
    }) => void
  ): (() => void) => {
    const listener = (
      _event: unknown,
      request: { callId: string; streamId: string; toolName: string; args: unknown }
    ) => callback(request);
    ipcRenderer.on(IPC.TOOL_CONFIRM_REQUEST, listener);
    return () => ipcRenderer.removeListener(IPC.TOOL_CONFIRM_REQUEST, listener);
  },

  confirmTool: (callId: string, approved: boolean): void => {
    void ipcRenderer.invoke(IPC.TOOL_CONFIRM, callId, approved);
  },

  /** app-szintu ertesites (pl. migracios uzenet az elso indulaskor) */
  onNotice: (callback: (message: string) => void): (() => void) => {
    const listener = (_event: unknown, message: string) => callback(message);
    ipcRenderer.on(IPC.APP_NOTICE, listener);
    return () => ipcRenderer.removeListener(IPC.APP_NOTICE, listener);
  },

  setExpanded: (expanded: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.SET_EXPANDED, expanded),

  hideWindow: (): void => {
    void ipcRenderer.invoke(IPC.HIDE_WINDOW);
  },
  minimizeWindow: (): void => {
    void ipcRenderer.invoke(IPC.MINIMIZE_WINDOW);
  },
  toggleMaximize: (): void => {
    void ipcRenderer.invoke(IPC.TOGGLE_MAXIMIZE);
  },
  quitApp: (): void => {
    void ipcRenderer.invoke(IPC.QUIT_APP);
  },

  /**
   * Streamelt chat: a chunkok push csatornan (on) erkeznek a sajat streamId-nkre
   * szurve, a vegleges eredmenyt viszont az invoke promise adja vissza.
   */
  ollamaChatStream: (
    request: OllamaChatStreamRequest,
    onChunk: (chunk: OllamaChatChunk) => void
  ): Promise<OllamaChatStreamResult> => {
    const listener = (_event: unknown, chunk: OllamaChatChunk) => {
      if (chunk.streamId === request.streamId) onChunk(chunk);
    };
    ipcRenderer.on(IPC.OLLAMA_CHAT_CHUNK, listener);
    return ipcRenderer
      .invoke(IPC.OLLAMA_CHAT_STREAM, request)
      .finally(() => ipcRenderer.removeListener(IPC.OLLAMA_CHAT_CHUNK, listener));
  },

  testOllama: (host: string, model: string): Promise<OllamaTestResult> =>
    ipcRenderer.invoke(IPC.TEST_OLLAMA, host, model),

  listModels: (host: string): Promise<string[]> => ipcRenderer.invoke(IPC.LIST_MODELS, host),

  queryGpu: (): Promise<GpuInfo | null> => ipcRenderer.invoke(IPC.QUERY_GPU),
  queryRam: (): Promise<RamInfo> => ipcRenderer.invoke(IPC.QUERY_RAM),

  // --- F1: diagnosztika ---
  diagnostics: {
    run: () => ipcRenderer.invoke(IPC.DIAG_RUN)
  },

  // --- F3: memoria ---
  memory: {
    list: () => ipcRenderer.invoke(IPC.MEMORY_LIST),
    upsert: (input: unknown) => ipcRenderer.invoke(IPC.MEMORY_UPSERT, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.MEMORY_DELETE, id),
    candidates: () => ipcRenderer.invoke(IPC.MEMORY_CANDIDATES),
    acceptCandidate: (id: string, overrides?: unknown) =>
      ipcRenderer.invoke(IPC.MEMORY_ACCEPT_CANDIDATE, id, overrides),
    rejectCandidate: (id: string) => ipcRenderer.invoke(IPC.MEMORY_REJECT_CANDIDATE, id),
    rawGet: () => ipcRenderer.invoke(IPC.MEMORY_RAW_GET),
    rawSet: (json: string) => ipcRenderer.invoke(IPC.MEMORY_RAW_SET, json),
    estimate: () => ipcRenderer.invoke(IPC.MEMORY_ESTIMATE),
    buildPrompt: () => ipcRenderer.invoke(IPC.MEMORY_BUILD_PROMPT)
  },

  // --- F4: beszelgetesek ---
  conversations: {
    list: (opts?: unknown) => ipcRenderer.invoke(IPC.CONV_LIST, opts),
    get: (id: string) => ipcRenderer.invoke(IPC.CONV_GET, id),
    create: () => ipcRenderer.invoke(IPC.CONV_CREATE),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.CONV_RENAME, id, title),
    remove: (id: string) => ipcRenderer.invoke(IPC.CONV_DELETE, id),
    archive: (id: string, archived: boolean) =>
      ipcRenderer.invoke(IPC.CONV_ARCHIVE, id, archived),
    export: (id: string) => ipcRenderer.invoke(IPC.CONV_EXPORT, id),
    search: (query: string, limit?: number) =>
      ipcRenderer.invoke(IPC.CONV_SEARCH, query, limit),
    fork: (sourceId: string, uptoMessageId?: string) =>
      ipcRenderer.invoke(IPC.CONV_FORK, sourceId, uptoMessageId),
    generateTitle: (id: string, force?: boolean) =>
      ipcRenderer.invoke(IPC.CONV_GENERATE_TITLE, id, force),
    messages: (conversationId: string) => ipcRenderer.invoke(IPC.MSG_LIST, conversationId),
    appendMessage: (input: unknown) => ipcRenderer.invoke(IPC.MSG_APPEND, input),
    updateMessage: (id: string, updates: unknown) =>
      ipcRenderer.invoke(IPC.MSG_UPDATE, id, updates)
  },

  // --- F4: indexeles ---
  index: {
    status: () => ipcRenderer.invoke(IPC.INDEX_STATUS),
    enqueue: (
      messageId: string,
      conversationId: string,
      content: string,
      role: 'user' | 'assistant'
    ) => ipcRenderer.invoke(IPC.INDEX_ENQUEUE, messageId, conversationId, content, role),
    rebuild: () => ipcRenderer.invoke(IPC.INDEX_REBUILD)
  },

  // --- F5: kontextus ---
  artifacts: {
    get: (id: string) => ipcRenderer.invoke(IPC.ARTIFACT_GET, id),
    list: (conversationId: string) => ipcRenderer.invoke(IPC.ARTIFACT_LIST, conversationId)
  },
  compaction: {
    run: (conversationId: string) => ipcRenderer.invoke(IPC.COMPACTION_RUN, conversationId)
  },

  // --- F6: eszkozok ---
  tools: {
    list: () => ipcRenderer.invoke(IPC.TOOLS_LIST),
    catalog: () => ipcRenderer.invoke(IPC.TOOLS_CATALOG),
    pickFilesRoot: () => ipcRenderer.invoke(IPC.FILES_PICK_ROOT)
  },

  // --- F7: router ---
  router: {
    route: (input: {
      currentMessage: string;
      recentHistory?: unknown[];
      conversationId?: string | null;
    }) => ipcRenderer.invoke(IPC.ROUTER_ROUTE, input),
    log: (limit?: number) => ipcRenderer.invoke(IPC.ROUTER_LOG, limit),
    modelStatus: () => ipcRenderer.invoke(IPC.MODEL_STATUS),
    preload: (model?: string) => ipcRenderer.invoke(IPC.MODEL_PRELOAD, model)
  },

  // --- F9: skillek ---
  skills: {
    list: () => ipcRenderer.invoke(IPC.SKILLS_LIST),
    load: (name: string) => ipcRenderer.invoke(IPC.SKILLS_LOAD, name),
    catalog: () => ipcRenderer.invoke(IPC.SKILLS_CATALOG),
    reload: () => ipcRenderer.invoke(IPC.SKILLS_RELOAD),
    create: (name: string) => ipcRenderer.invoke(IPC.SKILLS_CREATE, name),
    openFolder: () => ipcRenderer.invoke(IPC.SKILLS_OPEN_FOLDER)
  },

  // --- model browser ---
  models: {
    installed: (): Promise<InstalledModelsResult> => ipcRenderer.invoke(IPC.MODELS_INSTALLED),
    remove: (tag: string): Promise<ModelOpResult> => ipcRenderer.invoke(IPC.MODELS_DELETE, tag),
    /** progress arrives on a push channel filtered to this tag; the result ends the download */
    pull: (tag: string, onProgress: (progress: PullProgress) => void): Promise<ModelOpResult> => {
      const listener = (_event: unknown, progress: PullProgress) => {
        if (progress.tag === tag) onProgress(progress);
      };
      ipcRenderer.on(IPC.MODELS_PULL_PROGRESS, listener);
      return ipcRenderer
        .invoke(IPC.MODELS_PULL, tag)
        .finally(() => ipcRenderer.removeListener(IPC.MODELS_PULL_PROGRESS, listener));
    },
    cancelPull: (tag: string): Promise<boolean> => ipcRenderer.invoke(IPC.MODELS_PULL_CANCEL, tag)
  }
};

export type CompanionBridge = typeof companionBridge;

contextBridge.exposeInMainWorld('companion', companionBridge);
