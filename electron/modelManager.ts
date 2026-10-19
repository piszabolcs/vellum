// ============================================================================
// vellum - modelManager.ts (F7)
// ============================================================================
// modell-betoltes kezelese es az indexeles utemezese.
//
// KET FELADATA VAN:
//
// 1. MODELL-ELOTOLTES: ha a router nagy modellt ker, azt a hatterben
//    elinditjuk, mig a felhasznalo meg olvas. igy a betoltesi ido nem
//    a felhasznalo ideje.
//
// 2. ZOLD JELZES AZ INDEXELESNEK: az embedding modell betoltese kiszoritana
//    a chat modellt a memoriabol. ezert az indexeles csak akkor futhat,
//    ha nincs folyamatban chat-valasz.
//
// A MERT HARDVERES VALOSAG (8 gb vram + 32 gb ram):
// a qwen3:30b-a3b-q4_K_M csak 8192-es kontextussal fer el, epp hogy.
// ezert a nagy modell alapbol KI VAN KAPCSOLVA, es a beallitasokban kell
// engedelyezni, figyelmeztetessel egyutt.
// ============================================================================

import { setPaused as setIndexerPaused } from './indexer';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export type ModelState = 'idle' | 'loading' | 'ready' | 'error';

export interface ModelStatus {
  /** melyik modell van most betoltve (vagy toltodik) */
  activeModel: string | null;
  state: ModelState;
  /** ha eppen tolt, mikor kezdte */
  loadingStartedAt: number | null;
  error: string | null;
  /** fut-e eppen chat valasz */
  chatInProgress: boolean;
}

export interface ModelManagerConfig {
  host: string;
  smallModel: string;
  largeModel: string;
  largeModelEnabled: boolean;
  numCtx: number;
  /** meddig varjunk a nagy modell betoltesere. alap: 90 mp */
  preloadTimeoutMs: number;
}

let config: ModelManagerConfig = {
  host: 'http://localhost:11434',
  smallModel: 'qwen3:30b-a3b-q4_K_M',
  largeModel: 'qwen3:30b-a3b-q4_K_M',
  largeModelEnabled: false,
  numCtx: 32768,
  preloadTimeoutMs: 90000,
};

export function configureModelManager(next: Partial<ModelManagerConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

let status: ModelStatus = {
  activeModel: null,
  state: 'idle',
  loadingStartedAt: null,
  error: null,
  chatInProgress: false,
};

/** a futo elotoltest meg lehet szakitani, ha a felhasznalo mast csinal */
let preloadController: AbortController | null = null;

export function getModelStatus(): ModelStatus {
  return { ...status };
}

type StatusListener = (status: ModelStatus) => void;
const listeners = new Set<StatusListener>();

export function onModelStatusChange(listener: StatusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  const snapshot = { ...status };
  for (const listener of listeners) listener(snapshot);
}

// ----------------------------------------------------------------------------
// chat allapot -- ez vezerli az indexelest
// ----------------------------------------------------------------------------

/**
 * a chat valasz indulasakor hivando.
 *
 * megallitja az indexelest, hogy az embedding modell ne szoritsa ki a
 * chat modellt a memoriabol.
 */
export function chatStarted(): void {
  status.chatInProgress = true;
  setIndexerPaused(true);
  notify();
}

/**
 * a chat valasz vegen hivando.
 *
 * kis kesleltetessel engedjuk el az indexelest: ha a felhasznalo gyorsan
 * ir egy kovetkezo uzenetet, ne induljon el feleslegesen.
 */
export function chatFinished(): void {
  status.chatInProgress = false;
  notify();

  setTimeout(() => {
    if (!status.chatInProgress) {
      setIndexerPaused(false);
    }
  }, 3000);
}

// ----------------------------------------------------------------------------
// elotoltes
// ----------------------------------------------------------------------------

export interface PreloadResult {
  ok: boolean;
  model: string;
  durationMs: number;
  /** ha nem sikerult, visszaesunk a kis modellre */
  fellBackToSmall: boolean;
  error?: string;
}

/**
 * betolt egy modellt a hatterben.
 *
 * a trukk: kuldunk egy ures kerest a modellnek. az ollama ilyenkor
 * betolti a modellt, de nem general semmit. a keep_alive megmondja,
 * meddig maradjon bent.
 */
export async function preloadModel(
  modelName: string,
  keepAlive = '10m',
): Promise<PreloadResult> {
  const startedAt = Date.now();

  // ha mar ez a modell aktiv, nincs teendo
  if (status.activeModel === modelName && status.state === 'ready') {
    return {
      ok: true,
      model: modelName,
      durationMs: 0,
      fellBackToSmall: false,
    };
  }

  // ha eppen mast toltunk, szakitsuk meg
  if (preloadController) {
    preloadController.abort();
    preloadController = null;
  }

  status = {
    ...status,
    activeModel: modelName,
    state: 'loading',
    loadingStartedAt: Date.now(),
    error: null,
  };
  notify();

  preloadController = new AbortController();
  const timer = setTimeout(
    () => preloadController?.abort(),
    config.preloadTimeoutMs,
  );

  try {
    const response = await fetch(`${config.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: preloadController.signal,
      body: JSON.stringify({
        model: modelName,
        messages: [],
        stream: false,
        keep_alive: keepAlive,
        options: { num_ctx: config.numCtx },
      }),
    });

    clearTimeout(timer);
    preloadController = null;

    if (!response.ok) {
      const body = await response.text();

      status = {
        ...status,
        state: 'error',
        error: `HTTP ${response.status}: ${body.slice(0, 150)}`,
        loadingStartedAt: null,
      };
      notify();

      return {
        ok: false,
        model: modelName,
        durationMs: Date.now() - startedAt,
        fellBackToSmall: false,
        error: status.error ?? undefined,
      };
    }

    status = {
      ...status,
      state: 'ready',
      loadingStartedAt: null,
      error: null,
    };
    notify();

    return {
      ok: true,
      model: modelName,
      durationMs: Date.now() - startedAt,
      fellBackToSmall: false,
    };
  } catch (error) {
    clearTimeout(timer);
    preloadController = null;

    const isAbort = error instanceof Error && error.name === 'AbortError';

    const message = isAbort
      ? `a modell betöltése nem fejeződött be ${Math.round(config.preloadTimeoutMs / 1000)} másodperc alatt`
      : error instanceof Error
        ? error.message
        : 'ismeretlen hiba a modell betöltésekor';

    status = {
      ...status,
      state: 'error',
      error: message,
      loadingStartedAt: null,
    };
    notify();

    return {
      ok: false,
      model: modelName,
      durationMs: Date.now() - startedAt,
      fellBackToSmall: false,
      error: message,
    };
  }
}

// ----------------------------------------------------------------------------
// modellvalasztas a router alapjan
// ----------------------------------------------------------------------------

export interface ModelChoice {
  /** melyik modellt hasznaljuk vegul */
  model: string;
  /** kell-e varni a betoltesre */
  needsPreload: boolean;
  /** uzenet a felhasznalonak, ha varakozni kell */
  userMessage?: string;
}

/**
 * eldonti, melyik modellt hasznaljuk, es kell-e elotolteni.
 *
 * ha a nagy modell kene, de nem fer be vagy nem sikerul betolteni,
 * CSENDBEN visszaesunk a kicsire -- de a felhasznalonak szolunk.
 */
export function chooseModel(tier: 'small' | 'large'): ModelChoice {
  if (tier === 'small' || !config.largeModelEnabled) {
    return {
      model: config.smallModel,
      needsPreload: status.activeModel !== config.smallModel,
    };
  }

  return {
    model: config.largeModel,
    needsPreload: status.activeModel !== config.largeModel,
    userMessage:
      'Nagyobb modellre váltok ehhez a kérdéshez, ez eltarthat egy percig.',
  };
}

/**
 * elokesziti a modellt a valaszadashoz.
 *
 * ha a nagy modell betoltese nem sikerul (jellemzoen memoriahiany miatt),
 * visszaesunk a kicsire, es ezt jelezzuk.
 */
export async function prepareModel(
  tier: 'small' | 'large',
): Promise<{ model: string; fellBack: boolean; message?: string }> {
  const choice = chooseModel(tier);

  if (!choice.needsPreload) {
    return { model: choice.model, fellBack: false };
  }

  const result = await preloadModel(choice.model);

  if (result.ok) {
    return { model: choice.model, fellBack: false };
  }

  // a nagy modell nem toltodott be -> vissza a kicsire
  if (choice.model !== config.smallModel) {
    await preloadModel(config.smallModel);

    return {
      model: config.smallModel,
      fellBack: true,
      message:
        'A nagyobb modell nem fért be a memóriába, ezért a kisebbel válaszolok. ' +
        `(${result.error ?? 'ismeretlen ok'})`,
    };
  }

  // meg a kis modell sem megy -> ezt mar nem tudjuk kezelni
  return {
    model: config.smallModel,
    fellBack: false,
    message: `A modell betöltése nem sikerült: ${result.error ?? 'ismeretlen hiba'}`,
  };
}

// ----------------------------------------------------------------------------
// modell kiuritese
// ----------------------------------------------------------------------------

/**
 * kiuriti a modellt a memoriabol.
 *
 * akkor hasznos, ha a vision modellt akarjuk betolteni, ami kiszoritana
 * a fo modellt. igy legalabb kontrollaltan tortenik.
 */
export async function unloadModel(modelName: string): Promise<boolean> {
  try {
    const response = await fetch(`${config.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: modelName,
        messages: [],
        // a 0 keep_alive azonnali kiuritest jelent
        keep_alive: 0,
      }),
    });

    if (status.activeModel === modelName) {
      status = { ...status, activeModel: null, state: 'idle' };
      notify();
    }

    return response.ok;
  } catch {
    return false;
  }
}
