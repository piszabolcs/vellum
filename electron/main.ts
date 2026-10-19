import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { applyAutostart } from './autostart';
import { queryGpu } from './gpu';
import {
  listModels,
  ollamaChatStreamWithFallback,
  ollamaHealthCheck,
  setConfirmHandler
} from './ollama';
import { queryRam } from './ram';
import {
  APP_ID,
  AppSettings,
  FILES,
  IPC,
  isModelTag,
  OllamaChatChunk,
  OllamaChatStreamRequest
} from './shared';
import { deleteModel, listInstalledModels, pullModel } from './modelLibrary';
import { loadSettings, saveSettings, takeSettingsLoadIssue } from './settingsStore';
import { validateSettingsPatch } from './settingsValidation';
import { setMainLanguage, tr } from './i18n';
import { createTray, rebuildMenu } from './tray';
import {
  createMainWindow,
  getMainWindow,
  hideWindow,
  markQuitting,
  minimizeWindow,
  setAlwaysOnTop,
  setCorner,
  setExpanded,
  setLargeText,
  setLayout,
  showWindow,
  toggleMaximizeWindow
} from './window';

// --- F0-F9: az Upgrade csomag moduljai ---
import {
  buildMigrationNotice,
  getPendingLegacyMemory,
  getVellumDir,
  markLegacyMemoryProcessed,
  runMigrationIfNeeded
} from './migration';
import { getStats, initDatabase } from './db';
import {
  acceptCandidate,
  buildMemoryPrompt,
  deleteEntry,
  estimateMemorySize,
  getRawMemory,
  initMemory,
  listCandidates,
  listEntries,
  loadMemory,
  rejectCandidate,
  setRawMemory,
  takeMemoryLoadIssue,
  upsertEntry
} from './memory';
import { configureLearner, migrateLegacyMemory } from './memoryLearner';
import { configureEmbeddings, ensureEmbeddingModel } from './embeddings';
import { configureIndexer, enqueueMessage, getIndexerStatus, reindexAll } from './indexer';
import { configureArtifacts, getArtifact, listArtifacts } from './artifacts';
import { configureCompaction, runCompaction } from './compaction';
import { configureRouter, getRouterLog, route } from './router';
import { configureReranker } from './reranker';
import { configureWebSearch } from './tools/websearch';
import {
  chatFinished,
  chatStarted,
  configureModelManager,
  getModelStatus,
  preloadModel
} from './modelManager';
import { configureDiagnostics, runDiagnostics } from './diagnostics';
import { registerBuiltinTools } from './tools';
import { buildCategoryCatalog, getAllTools } from './tools/registry';
import {
  buildSkillCatalogPrompt,
  createSkillFromTemplate,
  getCatalog,
  getSkillsForRouter,
  initSkills,
  loadSkillBody,
  loadSkillCatalog
} from './skills';
import {
  appendMessage,
  archiveConversation,
  createConversation,
  deleteConversation,
  exportConversationMarkdown,
  forkConversation,
  getConversation,
  getMessages,
  listConversations,
  renameConversation,
  searchMessages,
  updateMessage
} from './conversations';
import { configureTitler, generateTitle } from './titler';
import { applyHotkey, getHotkeyStatus, releaseHotkey } from './hotkey';
import { configureSelfConsistency, pickBestAnswer } from './selfConsistency';

// Explicit name so the data folder is always %APPDATA%\Vellum. Must run before
// loadSettings(), which already reads app.getPath('userData').
app.setName('Vellum');
// same id as the installer (package.json build.appId): taskbar grouping, notifications
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Optional separate profile (demo data, screenshots, tests): VELLUM_PROFILE_DIR
// replaces %APPDATA% as the parent of the "Vellum" data folder. Without it the
// data location is unchanged.
const profileRoot = process.env.VELLUM_PROFILE_DIR;
if (profileRoot) {
  app.setPath('appData', profileRoot);
  app.setPath('userData', path.join(profileRoot, 'Vellum'));
}

let settings: AppSettings = loadSettings();

/** igaz, ha a db megnyilt -- e nelkul a beszelgetes/kereses csatornak ures valaszt adnak */
let dbReady = false;

// Csak egy peldany futhat; masodik inditas a meglevo ablakot hozza fel.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    void bootstrap();
  });

  app.on('before-quit', () => {
    markQuitting();
    // a globalis gyorsbillentyu az egesz rendszerre szol, ezert kilepeskor
    // kotelezo elengedni
    releaseHotkey();
  });

  // Tray-alapu app: minden ablak bezarasa utan is fut tovabb.
  app.on('window-all-closed', () => {
    // szandekosan ures - a tray tartja eletben az appot
  });
}

/**
 * Az app indulasa. A SORREND SZAMIT:
 *   1. migracio (mindig legeloszor, mert a settings.json-t is o hozza at)
 *   2. beallitasok ujraolvasasa (a migracio irhatott bele)
 *   3. adatbazis
 *   4. memoria
 *   5. skillek
 *   6. a tobbi modul konfiguralasa
 *   7. eszkozok regisztralasa
 *   8. regi memoria atalakitasa (hatterben, mert ehhez mar kell a modell)
 *   9. ablak + tray + ipc
 */
async function bootstrap(): Promise<void> {
  const appDataRoot = app.getPath('appData');
  const vellumDir = getVellumDir(appDataRoot);

  // --- 1. MIGRACIO ---
  const migration = await runMigrationIfNeeded(appDataRoot);

  // --- 2. BEALLITASOK ujraolvasasa ---
  // a migracio lehet, hogy epp most irta ki a settings.json-t a Haverombol
  settings = loadSettings();
  setMainLanguage(settings.language);
  const migrationNotice = buildMigrationNotice(migration);
  const startupNotices: string[] = [];
  const corruptSettings = takeSettingsLoadIssue();
  if (corruptSettings) startupNotices.push(tr('notice.settingsCorrupt', { path: corruptSettings }));

  // --- 3. ADATBAZIS ---
  // ha nem sikerul, az app TOVABB MUKODIK, csak a beszelgetes-elozmeny es a
  // szemantikus kereses esik ki. egy hianyzo nativ modul ne vigye el a chatet.
  const dbResult = initDatabase({
    dbPath: path.join(vellumDir, FILES.database),
    embeddingDim: settings.embeddingModel === 'bge-m3' ? 1024 : 768,
    embeddingModel: settings.embeddingModel
  });
  dbReady = dbResult.ok;
  if (!dbResult.ok) {
    console.error('[vellum] database error:', dbResult.error);
    console.error('[vellum] chat keeps working, but history and search are unavailable.');
  } else if (dbResult.needsReindex) {
    console.warn('[vellum] the embedding model changed, a reindex is needed.');
  }

  // --- 4. MEMORIA ---
  initMemory(vellumDir);
  await loadMemory();
  const memoryIssue = takeMemoryLoadIssue();
  if (memoryIssue) {
    startupNotices.push(
      memoryIssue.backupPath
        ? tr('notice.memoryCorrupt', { path: memoryIssue.backupPath })
        : tr('notice.memoryLocked')
    );
  }

  // --- 5. SKILLEK ---
  initSkills(path.join(vellumDir, FILES.skillsDir));
  await installBundledSkills(path.join(vellumDir, FILES.skillsDir));
  await loadSkillCatalog();

  // --- 6. MODULOK KONFIGURALASA ---
  configureModules();

  // --- 7. ESZKOZOK ---
  registerBuiltinTools();
  // a destruktiv hivasok innentol megallnak, amig a felhasznalo nem dont
  setConfirmHandler(requestConfirmation);

  // --- 8. MODELL ELOTOLTESE ---
  // A nagy modellek hidegindítasa fel percnel is tovabb tarthat. Ha ezt az
  // indulaskor elinditjuk, az elso uzenetnel mar keszen all -- kulonben az
  // elso kerdes fizetne ki a teljes betoltesi idot, es ugy tunne, hogy az app
  // lassu. Hatterben fut, nem varunk ra.
  void preloadModel(settings.ollamaModel).catch(() => {
    // ha nem megy (nincs Ollama, nincs eleg memoria), a chat ettol meg mukodik
  });

  // --- 9. REGI MEMORIA ATALAKITASA ---
  // hatterben fut, nem blokkolja az indulast: ehhez mar kell a modell,
  // es a modell hidegindítasa percekig is tarthat.
  void convertLegacyMemory(vellumDir);

  // --- 9. ABLAK, TRAY, IPC ---
  createMainWindow(
    settings.alwaysOnTop,
    settings.bubbleCorner,
    settings.largeText,
    settings.layout
  );
  applyAutostart(settings.startWithWindows);
  registerHotkey();

  const trayCallbacks = {
    getSettings: () => settings,
    updateSettings: (partial: Partial<AppSettings>) => {
      applySettingsUpdate(partial);
    }
  };
  createTray(trayCallbacks);
  registerIpcHandlers(trayCallbacks);

  // az embedding modell megletet csak jelezzuk, nem blokkolunk vele
  void ensureEmbeddingModel().then((result) => {
    if (!result.ok) {
      console.warn(`[vellum] embedding: ${result.error ?? 'not available'}`);
      if (result.command) console.warn(`[vellum] run: ${result.command}`);
    }
  });

  if (migrationNotice) startupNotices.unshift(migrationNotice);
  if (startupNotices.length > 0) {
    // az ablak meg toltodik, ezert megvarjuk a betoltest
    const win = getMainWindow();
    win?.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.APP_NOTICE, startupNotices.join('\n'));
    });
  }
}

/** The tool categories the model may use; the Skills switch turns its category off. */
function enabledCategories(): string[] {
  return settings.skillsEnabled
    ? settings.enabledToolCategories
    : settings.enabledToolCategories.filter((category) => category !== 'skills');
}

/**
 * A beallitasokat atadja az Upgrade moduloknak.
 *
 * Itt tortenik a REGI -> UJ mezonev lekepezes (ollamaModel -> model stb.),
 * ezert kellett csak EGY helyen megcsinalni: a modulok configure() hivasai
 * a sajat nevukon varjak az ertekeket.
 */
function configureModules(): void {
  const helperModel = settings.helperModel || settings.ollamaModel;

  configureEmbeddings({
    host: settings.ollamaHost,
    model: settings.embeddingModel,
    // FONTOS: rovid, hogy ne szoritsa ki a chat modellt a memoriabol
    keepAlive: '30s'
  });

  configureIndexer({
    embeddingModel: settings.embeddingModel,
    chunkSizeTokens: settings.chunkSizeTokens,
    chunkOverlapTokens: settings.chunkOverlapTokens
  });

  configureArtifacts({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: settings.ollamaContextSize,
    thresholdTokens: settings.offloadThresholdTokens
  });

  configureCompaction({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: settings.ollamaContextSize,
    keepRecentMessages: settings.keepRecentMessages,
    threshold: settings.compactionThreshold
  });

  configureTitler({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: 8192 // par uzenet elejebol dolgozik, nem kell tobb
  });

  configureSelfConsistency({
    host: settings.ollamaHost,
    model: helperModel,
    // a valasztonak mindharom valaszt latnia kell egyszerre
    numCtx: 16384
  });

  configureRouter({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: 8192, // a routernek nem kell nagy kontextus
    timeoutMs: settings.routerTimeoutMs,
    language: settings.language,
    englishSearchQueries: settings.englishSearchQueries,
    largeModelEnabled: settings.largeModelEnabled
  });

  configureReranker({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: 8192
  });

  configureWebSearch({
    maxPagesToFetch: settings.maxPagesToFetch,
    deepSearchEnabled: settings.deepSearchEnabled,
    rerankEnabled: settings.rerankEnabled,
    respectRobotsTxt: settings.respectRobotsTxt
  });

  configureLearner({
    host: settings.ollamaHost,
    model: helperModel,
    numCtx: 16384
  });

  configureModelManager({
    host: settings.ollamaHost,
    smallModel: settings.ollamaModel,
    largeModel: settings.largeModelName,
    largeModelEnabled: settings.largeModelEnabled,
    numCtx: settings.ollamaContextSize
  });

  configureDiagnostics(settings.ollamaHost);
}

/**
 * A beepitett skilleket egyszer atmasolja a felhasznaloi skills mappaba.
 *
 * Miert masolas es nem olvasas a csomagbol: igy a felhasznalo SZERKESZTHETI
 * oket (ez a skill-rendszer lenyege), es nem vesznek el egy frissiteskor.
 * Ha mar letezik a mappa, nem irjuk felul.
 */
async function installBundledSkills(skillsDir: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const bundledDir = app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(app.getAppPath(), 'skills');

  try {
    const names = await fs.readdir(bundledDir);
    for (const name of names) {
      const target = path.join(skillsDir, name);
      try {
        await fs.access(target);
        continue; // mar letezik, nem nyulunk hozza
      } catch {
        // nincs meg, masoljuk
      }
      await fs.cp(path.join(bundledDir, name), target, { recursive: true });
    }
  } catch {
    // nincs beepitett skill mappa, ez nem hiba
  }
}

/**
 * A regi, szabad szoveges memory.md atalakitasa tipizalt bejegyzesekke.
 *
 * Az eredmeny JAVASLATKENT kerul be (candidates), nem kesz bejegyzeskent -
 * jovahagyas nelkul a memoria fel ev alatt szemetdomb lenne.
 */
async function convertLegacyMemory(vellumDir: string): Promise<void> {
  const pending = await getPendingLegacyMemory(vellumDir);
  if (!pending) return;

  const result = await migrateLegacyMemory(pending);
  if (!result.ok) return;

  await markLegacyMemoryProcessed(vellumDir);

  if (result.migrated > 0) {
    const notice = result.fallbackUsed
      ? tr('notice.legacyFallback')
      : tr('notice.legacyMigrated', { count: result.migrated });
    getMainWindow()?.webContents.send(IPC.APP_NOTICE, notice);
  }
}

/**
 * F11: a globalis gyorsbillentyu (ujra)regisztralasa.
 *
 * Az ablakot elohozza, es ha mar elol van, elrejti -- igy ugyanaz a billentyu
 * oda-vissza kapcsol, nem kell kulon elrejteni.
 */
function registerHotkey(): void {
  applyHotkey(settings.globalHotkey, () => {
    const win = getMainWindow();
    if (win && win.isVisible() && win.isFocused()) hideWindow();
    else showWindow();
  });
}

// ----------------------------------------------------------------------------
// F6: destruktiv eszkozok megerositese
// ----------------------------------------------------------------------------
// A tool-loop megall, amig a felhasznalo donti. Ez egy nyitott igeret a main
// oldalon, amit a renderer valasza (TOOL_CONFIRM) zar le.

/** ha ennyi ideig nem jon valasz, elutasitasnak vesszuk */
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

const pendingConfirmations = new Map<string, (approved: boolean) => void>();
let confirmCounter = 0;

function resolveConfirmation(callId: string, approved: boolean): void {
  const resolve = pendingConfirmations.get(callId);
  if (!resolve) return; // mar lejart vagy ketszer erkezett valasz
  pendingConfirmations.delete(callId);
  resolve(approved);
}

function requestConfirmation(request: {
  streamId: string;
  toolName: string;
  args: unknown;
}): Promise<boolean> {
  const win = getMainWindow();

  // Ablak nelkul nincs kit megkerdezni. Ilyenkor a NEM a helyes valasz:
  // egy destruktiv muvelet ne fusson le azert, mert nem volt kit megkerdezni.
  if (!win) return Promise.resolve(false);

  confirmCounter += 1;
  const callId = `confirm-${confirmCounter}`;

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConfirmations.delete(callId);
      resolve(approved);
    };

    const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);

    pendingConfirmations.set(callId, finish);

    win.webContents.send(IPC.TOOL_CONFIRM_REQUEST, {
      callId,
      streamId: request.streamId,
      toolName: request.toolName,
      args: request.args
    });
  });
}

/**
 * F11: K valasz generalasa, majd a legjobb kivalasztasa.
 *
 * A futasok EGYMAS UTAN mennek, nem parhuzamosan: egy nagy modellbol egyszerre
 * tobb peldany nem fer a memoriaba, a parhuzamositas itt lassitana.
 *
 * Streameles: csak az ELSO futast kuldjuk ki elore, hogy legyen mit nezni.
 * Ha a valasztas vegul masik valaszra esik, a vegeredmeny felulirja a
 * kepernyon levo szoveget -- a renderer amugy is a vegeredmenyt tekinti
 * hitelesnek, nem a delta-akkumulaciot.
 */
async function runSelfConsistentChat(
  request: Parameters<typeof ollamaChatStreamWithFallback>[0],
  forward: (chunk: OllamaChatChunk) => void,
  k: number
): Promise<Awaited<ReturnType<typeof ollamaChatStreamWithFallback>>> {
  const runs: Awaited<ReturnType<typeof ollamaChatStreamWithFallback>>[] = [];

  for (let i = 0; i < k; i++) {
    const isFirst = i === 0;
    const result = await ollamaChatStreamWithFallback(
      request,
      // a tobbi futas nemán megy, csak a "kesz" jelzest nem kuldjuk ki idő elott
      isFirst ? (chunk) => forward({ ...chunk, done: false }) : () => {}
    );

    // hiba eseten nincs ertelme tovabb probalkozni: ugyanaz fog jonni
    if (!result.ok) {
      if (isFirst) return result;
      break;
    }

    runs.push(result);
  }

  if (runs.length === 0) {
    return { ok: false, message: tr('chat.noAnswer') };
  }

  const pick = await pickBestAnswer(runs.map((r) => r.message));
  const chosen = runs[pick.index] ?? runs[0];

  forward({ streamId: request.streamId, done: true });

  return {
    ...chosen,
    // a felhasznalo lassa, hogy tobb valaszbol valasztottunk
    selfConsistency: { runs: runs.length, chosen: pick.index + 1, reason: pick.reason }
  };
}

function applySettingsUpdate(partial: Partial<AppSettings>): AppSettings {
  settings = { ...settings, ...partial };
  saveSettings(settings);
  if ('language' in partial) setMainLanguage(settings.language);

  if ('alwaysOnTop' in partial) setAlwaysOnTop(settings.alwaysOnTop);
  if ('startWithWindows' in partial) applyAutostart(settings.startWithWindows);
  if ('bubbleCorner' in partial) setCorner(settings.bubbleCorner);
  if ('layout' in partial) setLayout(settings.layout);
  if ('largeText' in partial) setLargeText(settings.largeText);
  if ('globalHotkey' in partial) registerHotkey();

  // az Upgrade modulok configure() hivasai NEM reaktivak, ezert minden
  // beallitas-valtozas utan ujra le kell futniuk
  configureModules();

  rebuildMenu({
    getSettings: () => settings,
    updateSettings: (p: Partial<AppSettings>) => {
      applySettingsUpdate(p);
    }
  });
  getMainWindow()?.webContents.send(IPC.SETTINGS_CHANGED, settings);
  return settings;
}

// ----------------------------------------------------------------------------
// ipc
// ----------------------------------------------------------------------------

/**
 * Every invoke handler goes through here: only our own window may call the
 * main process (no other webContents, no future popup or devtools page).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const win = getMainWindow();
    if (!win || event.sender !== win.webContents) {
      throw new Error(`IPC ${channel}: rejected sender`);
    }
    return listener(event, ...args);
  });
}

/** A drive root or a folder that contains the user profile is far too broad. */
function isBroadRoot(folder: string): boolean {
  const resolved = path.resolve(folder).toLowerCase();
  const home = os.homedir().toLowerCase();
  return path.parse(resolved).root === resolved || home === resolved || home.startsWith(resolved + path.sep);
}

let dbErrorNotified = false;

/** running model downloads by tag; only one at a time */
const activePulls = new Map<string, AbortController>();

function registerIpcHandlers(trayCallbacks: {
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
}): void {
  void trayCallbacks;

  // --- app es ablak ---
  handle(IPC.GET_BOOTSTRAP, () => ({
    settings,
    appVersion: app.getVersion()
  }));

  handle(IPC.UPDATE_SETTINGS, (_event, raw: unknown) => {
    const { patch, rejected } = validateSettingsPatch(raw);
    if (rejected.length > 0) console.warn('[vellum] settings:update rejected keys:', rejected.join(', '));
    return Object.keys(patch).length > 0 ? applySettingsUpdate(patch) : settings;
  });

  handle(IPC.SET_EXPANDED, (_event, expanded: boolean) => {
    setExpanded(expanded);
  });
  handle(IPC.HIDE_WINDOW, () => hideWindow());
  handle(IPC.MINIMIZE_WINDOW, () => minimizeWindow());
  handle(IPC.TOGGLE_MAXIMIZE, () => toggleMaximizeWindow());
  handle(IPC.QUIT_APP, () => {
    markQuitting();
    app.quit();
  });

  // --- chat ---
  // A streamelt darabokat push csatornan kuldjuk, a vegeredmeny az invoke
  // promise-ban ter vissza (lasd preload.ts ollamaChatStream).
  handle(IPC.OLLAMA_CHAT_STREAM, async (event, request: OllamaChatStreamRequest) => {
    // KOTELEZO: e nelkul az indexeles kiszoritja a chat modellt a memoriabol
    chatStarted();

    const enriched = {
      ...request,
      // the renderer does not get to choose where the conversation is sent
      host: settings.ollamaHost,
      settings: {
        filesRootPath: settings.filesRootPath,
        ollamaHost: settings.ollamaHost,
        webSearchEnabled: settings.webSearchEnabled,
        maxToolCallsPerTurn: settings.maxToolCallsPerTurn,
        maxNudges: settings.maxNudges,
        enabledToolCategories: enabledCategories(),
        thinkingBudgetTokens: settings.thinkingBudgetTokens
      }
    };

    const forward = (chunk: OllamaChatChunk) => {
      event.sender.send(IPC.OLLAMA_CHAT_CHUNK, chunk);
    };

    try {
      // F11: nehez kerdesnel tobb valasz, majd a legjobb kivalasztasa.
      // Csak akkor, ha a router is nehéznek itelte -- kulonben minden
      // "szia"-ra haromszor futna a modell.
      const useSelfConsistency =
        settings.selfConsistencyEnabled &&
        settings.selfConsistencyK > 1 &&
        request.decision?.intent === 'reasoning';

      const result = useSelfConsistency
        ? await runSelfConsistentChat(enriched, forward, settings.selfConsistencyK)
        : await ollamaChatStreamWithFallback(enriched, forward);

      if (result.contextFallback) {
        applySettingsUpdate({ ollamaContextSize: result.contextFallback.to });
      }
      return result;
    } finally {
      chatFinished();
    }
  });

  // --- F7: modell-elotoltes ---
  handle(IPC.MODEL_PRELOAD, (_event, model?: string) =>
    preloadModel(model || settings.ollamaModel)
  );

  // --- F6: destruktiv eszkozok megerositese ---
  handle(IPC.TOOL_CONFIRM, (_event, callId: string, approved: boolean) => {
    resolveConfirmation(callId, approved);
  });

  handle(IPC.TEST_OLLAMA, (_event, host: string, model: string) =>
    ollamaHealthCheck(host, model)
  );
  handle(IPC.LIST_MODELS, (_event, host: string) => listModels(host));

  // --- hardver ---
  handle(IPC.QUERY_GPU, () => queryGpu());
  handle(IPC.QUERY_RAM, () => queryRam());

  // --- F1: diagnosztika ---
  handle(IPC.DIAG_RUN, async () => {
    const diag = await runDiagnostics();

    // A gyorsbillentyu utkozese nem az Ollamarol szol, ezert nincs benne a
    // diagnostics modulban -- de a felhasznalonak ugyanitt kell latnia, mert
    // maskepp csak annyit tapasztal, hogy "nem reagal a billentyu".
    const hotkey = getHotkeyStatus();
    if (hotkey.accelerator && !hotkey.registered) {
      diag.suggestions.push({
        severity: 'warning',
        title: tr('diag.hotkeyTitle', { accelerator: hotkey.accelerator }),
        detail: tr('diag.hotkeyDetail', { reason: hotkey.error ?? tr('diag.unknownReason') })
      });
      diag.rawText += `\n\n${tr('diag.hotkeyRaw', { accelerator: hotkey.accelerator, reason: hotkey.error ?? '?' })}`;
    }

    if (!dbReady) return diag;
    // a db statisztikat is hozzafuzzuk a nyers szoveghez, mert hibajelentesnel kell
    try {
      const vellumDir = getVellumDir(app.getPath('appData'));
      const stats = getStats(path.join(vellumDir, FILES.database));
      diag.rawText +=
        `\n\n--- Database ---\n` +
        `Conversations: ${stats.conversations}\n` +
        `Messages: ${stats.messages}\n` +
        `Chunks: ${stats.chunks}\n` +
        `Artifacts: ${stats.artifacts}\n` +
        `Vector search: ${stats.vectorSearchAvailable ? 'available' : 'NOT available'}\n` +
        `Embedding model: ${stats.embeddingModel ?? 'unknown'}\n` +
        `File size: ${(stats.fileSizeBytes / 1024 / 1024).toFixed(1)} MB`;
    } catch {
      // ha a statisztika nem megy, a diagnosztika tobbi resze meg ertekes
    }
    return diag;
  });

  // --- F3: memoria ---
  handle(IPC.MEMORY_LIST, () => listEntries());
  handle(IPC.MEMORY_UPSERT, (_e, input) => upsertEntry(input));
  handle(IPC.MEMORY_DELETE, (_e, id: string) => deleteEntry(id));
  handle(IPC.MEMORY_CANDIDATES, () => listCandidates());
  handle(IPC.MEMORY_ACCEPT_CANDIDATE, (_e, id: string, overrides) =>
    acceptCandidate(id, overrides)
  );
  handle(IPC.MEMORY_REJECT_CANDIDATE, (_e, id: string) => rejectCandidate(id));
  handle(IPC.MEMORY_RAW_GET, () => getRawMemory());
  handle(IPC.MEMORY_RAW_SET, (_e, json: string) => setRawMemory(json));
  handle(IPC.MEMORY_ESTIMATE, () => estimateMemorySize());
  handle(IPC.MEMORY_BUILD_PROMPT, () => buildMemoryPrompt());

  // --- F4: beszelgetesek ---
  handle(IPC.CONV_LIST, (_e, opts) => (dbReady ? listConversations(opts) : []));
  handle(IPC.CONV_GET, (_e, id: string) => (dbReady ? getConversation(id) : null));
  handle(IPC.CONV_CREATE, () =>
    dbReady ? createConversation(settings.ollamaModel) : null
  );
  handle(IPC.CONV_RENAME, (_e, id: string, title: string) =>
    dbReady ? renameConversation(id, title) : false
  );
  handle(IPC.CONV_DELETE, (_e, id: string) => (dbReady ? deleteConversation(id) : false));
  handle(IPC.CONV_ARCHIVE, (_e, id: string, archived: boolean) =>
    dbReady ? archiveConversation(id, archived) : false
  );
  handle(IPC.CONV_EXPORT, (_e, id: string) =>
    dbReady ? exportConversationMarkdown(id) : null
  );
  handle(IPC.CONV_SEARCH, (_e, query: string, limit?: number) =>
    dbReady ? searchMessages(query, limit) : []
  );
  handle(IPC.CONV_FORK, (_e, sourceId: string, uptoMessageId?: string) =>
    dbReady ? forkConversation(sourceId, uptoMessageId) : null
  );
  handle(IPC.CONV_GENERATE_TITLE, async (_e, id: string, force?: boolean) =>
    dbReady ? generateTitle(id, force) : { ok: false, error: tr('db.unavailable') }
  );
  handle(IPC.MSG_LIST, (_e, conversationId: string) =>
    dbReady ? getMessages(conversationId) : []
  );
  handle(IPC.MSG_APPEND, (_e, input) => {
    if (!dbReady) return null;
    if (
      !input ||
      typeof input.conversationId !== 'string' ||
      input.conversationId.length === 0 ||
      input.conversationId.length > 200 ||
      (input.role !== 'user' && input.role !== 'assistant') ||
      typeof input.content !== 'string'
    ) {
      throw new Error('msg:append: invalid message');
    }
    try {
      return appendMessage(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[vellum] msg:append failed:', reason);
      if (!dbErrorNotified) {
        dbErrorNotified = true;
        getMainWindow()?.webContents.send(IPC.APP_NOTICE, tr('notice.dbWriteFailed', { reason }));
      }
      return null;
    }
  });
  handle(IPC.MSG_UPDATE, (_e, id: string, updates) =>
    dbReady ? updateMessage(id, updates) : false
  );

  handle(IPC.INDEX_STATUS, () => getIndexerStatus());
  handle(
    IPC.INDEX_ENQUEUE,
    (_e, messageId: string, conversationId: string, content: string, role: 'user' | 'assistant') => {
      if (dbReady) enqueueMessage(messageId, conversationId, content, role);
    }
  );
  handle(IPC.INDEX_REBUILD, () =>
    dbReady ? reindexAll() : { ok: false, indexed: 0, error: tr('db.unavailable') }
  );

  // --- F5: kontextus ---
  handle(IPC.ARTIFACT_GET, (_e, id: string) => (dbReady ? getArtifact(id) : null));
  handle(IPC.ARTIFACT_LIST, (_e, conversationId: string) =>
    dbReady ? listArtifacts(conversationId) : []
  );
  handle(IPC.COMPACTION_RUN, async (_e, conversationId: string) => {
    if (!dbReady) return { ok: false, error: tr('db.unavailable') };
    const messages = getMessages(conversationId);
    return runCompaction(conversationId, messages);
  });

  // --- F6: eszkozok ---
  handle(IPC.TOOLS_LIST, () =>
    getAllTools().map((t) => ({
      name: t.name,
      category: t.category,
      shortDescription: t.shortDescription,
      destructive: t.destructive,
      needsNetwork: t.needsNetwork
    }))
  );
  handle(IPC.TOOLS_CATALOG, () => buildCategoryCatalog(enabledCategories()));
  // the ONLY way to set the file-tool root: a native dialog in the main process
  handle(IPC.FILES_PICK_ROOT, async () => {
    const win = getMainWindow();
    const options = { properties: ['openDirectory' as const], title: tr('dialog.pickRoot') };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    if (isBroadRoot(chosen)) {
      const boxOptions = {
        type: 'warning' as const,
        buttons: [tr('dialog.cancel'), tr('dialog.useAnyway')],
        defaultId: 0,
        cancelId: 0,
        message: tr('dialog.broadRootTitle'),
        detail: tr('dialog.broadRootDetail', { path: chosen })
      };
      const answer = win ? await dialog.showMessageBox(win, boxOptions) : await dialog.showMessageBox(boxOptions);
      if (answer.response !== 1) return null;
    }
    applySettingsUpdate({ filesRootPath: chosen });
    return chosen;
  });

  // --- F7: router ---
  handle(IPC.ROUTER_ROUTE, async (_e, input: { currentMessage: string; recentHistory?: unknown[]; conversationId?: string | null }) => {
    if (!settings.routerEnabled) return null;
    return route({
      currentMessage: input.currentMessage,
      recentHistory: (input.recentHistory ?? []) as never,
      availableCategories: enabledCategories(),
      availableSkills: settings.skillsEnabled ? getSkillsForRouter() : [],
      conversationId: input.conversationId ?? null
    });
  });
  handle(IPC.ROUTER_LOG, (_e, limit?: number) => (dbReady ? getRouterLog(limit) : []));
  handle(IPC.MODEL_STATUS, () => getModelStatus());

  // --- F9: skillek ---
  handle(IPC.SKILLS_LIST, () => getCatalog());
  handle(IPC.SKILLS_LOAD, (_e, name: string) => loadSkillBody(name));
  handle(IPC.SKILLS_CATALOG, () =>
    settings.skillsEnabled ? buildSkillCatalogPrompt() : ''
  );
  handle(IPC.SKILLS_RELOAD, () => loadSkillCatalog());
  handle(IPC.SKILLS_CREATE, (_e, name: string) => createSkillFromTemplate(name));
  handle(IPC.SKILLS_OPEN_FOLDER, () => {
    const vellumDir = getVellumDir(app.getPath('appData'));
    void shell.openPath(path.join(vellumDir, FILES.skillsDir));
  });

  // --- model browser: always the configured Ollama host, never a renderer-given one ---
  handle(IPC.MODELS_INSTALLED, () => listInstalledModels(settings.ollamaHost));
  handle(IPC.MODELS_DELETE, (_e, tag: unknown) => {
    if (!isModelTag(tag)) throw new Error('models:delete: invalid tag');
    return deleteModel(settings.ollamaHost, tag);
  });
  handle(IPC.MODELS_PULL, async (event, tag: unknown) => {
    if (!isModelTag(tag)) throw new Error('models:pull: invalid tag');
    if (activePulls.size > 0) return { ok: false, error: 'busy' };
    const controller = new AbortController();
    activePulls.set(tag, controller);
    try {
      return await pullModel(settings.ollamaHost, tag, controller.signal, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.MODELS_PULL_PROGRESS, progress);
      });
    } finally {
      activePulls.delete(tag);
    }
  });
  handle(IPC.MODELS_PULL_CANCEL, (_e, tag: unknown) => {
    if (!isModelTag(tag)) throw new Error('models:pull-cancel: invalid tag');
    const controller = activePulls.get(tag);
    controller?.abort();
    return Boolean(controller);
  });
}
