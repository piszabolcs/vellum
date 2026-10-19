// ============================================================================
// vellum - embeddings.ts (F4)
// ============================================================================
// az ollama sajat /api/embeddings vegpontjat hasznaljuk.
// nincs uj futtatokornyezet, nincs python, ugyanaz a szerver.
//
// MEMORIASTRATEGIA -- ez a resz fontos, mert felmerult a jogos aggaly,
// hogy a 8 gb vram-ba nem fer be az embedding modell a chat modell melle:
//
// az embedding NEM autoregressziv generalas, hanem egyetlen forward pass.
// a chat modell valaszadaskor tokenrol tokenre general, es minden egyes
// tokenhez vegigolvassa az osszes sulyat a memoriabol -- ezert
// memoriasavszelesseg-korlatos, es ezert kell neki gpu. egy embedding
// viszont: bemegy a szoveg, kijon egy vektor, vege. ez cpu-n is fut.
//
// ebbol kovetkezik:
//   - rovid keep_alive: betoltodik, lefut a koteg, magatol kiurul
//   - az indexeles kizarolag hatterben, csak ha nincs folyamatban chat
//
// AMIT TUDATOSAN NEM CSINALUNK: forditas elofeldolgozaskent.
// felmerult, hogy a magyar szoveget elobb angolra forditjuk. ez rossz irany:
//   1. chunkonkent egy llm-hivas -> ezer chunk = orak
//   2. aszimmetria: ha ugyanaz a fogalom indexeleskor "production line
//      downtime", lekerdezeskor meg "assembly line stoppage", a ket vektor
//      nem talal egymasra
//   3. a bge-m3 fo kepessege pont az, hogy az azonos jelentesu magyar es
//      angol szoveg egymas kozelebe kerul -- a forditas ezt dobna el
// ============================================================================

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface EmbeddingConfig {
  host: string;
  model: string;
  /** meddig maradjon a modell a memoriaban a hivas utan. alap: '30s' */
  keepAlive?: string;
  timeoutMs?: number;
}

export interface EmbeddingResult {
  ok: boolean;
  vectors: Float32Array[];
  error?: string;
  durationMs: number;
}

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

let config: EmbeddingConfig = {
  host: 'http://localhost:11434',
  model: 'bge-m3',
  keepAlive: '30s',
  timeoutMs: 120000,
};

/** az ismert modellek dimenzioi, hogy ne kelljen mindig lekerdezni */
const KNOWN_DIMENSIONS: Record<string, number> = {
  'bge-m3': 1024,
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'all-minilm': 384,
};

let detectedDim = 0;

export function configureEmbeddings(next: Partial<EmbeddingConfig>): void {
  config = { ...config, ...next };
  detectedDim = 0; // modellvaltasnal ujra kell deriteni
}

/**
 * megmondja, hany dimenzios vektort ad a beallitott modell.
 * elobb a ismert listabol probaljuk, aztan tenyleges hivasbol.
 */
export function getKnownDimension(model: string): number {
  // a modellnev tartalmazhat tag-et is (pl. "bge-m3:latest")
  const base = model.split(':')[0];
  return KNOWN_DIMENSIONS[base] ?? KNOWN_DIMENSIONS[model] ?? 0;
}

export function getDetectedDimension(): number {
  return detectedDim || getKnownDimension(config.model);
}

// ----------------------------------------------------------------------------
// cache
// ----------------------------------------------------------------------------
// ugyanahhoz a szoveghez ne kerjunk ujra embeddinget. ez foleg a
// lekerdezeseknel szamit, ahol ugyanaz a kerdes tobbszor is elofordulhat.

const CACHE_LIMIT = 500;
const cache = new Map<string, Float32Array>();

function cacheKey(text: string): string {
  return `${config.model}::${text}`;
}

function cacheGet(text: string): Float32Array | undefined {
  const key = cacheKey(text);
  const hit = cache.get(key);

  if (hit) {
    // lru: a hasznalt elemet a vegere tesszuk
    cache.delete(key);
    cache.set(key, hit);
  }

  return hit;
}

function cacheSet(text: string, vector: Float32Array): void {
  const key = cacheKey(text);

  if (cache.size >= CACHE_LIMIT) {
    // a legregebben hasznalt elem esik ki (a map elso eleme)
    const oldest = cache.keys().next().value;
    if (typeof oldest === 'string') cache.delete(oldest);
  }

  cache.set(key, vector);
}

export function clearEmbeddingCache(): void {
  cache.clear();
}

// ----------------------------------------------------------------------------
// alap hivas
// ----------------------------------------------------------------------------

async function callEmbeddingApi(input: string): Promise<Float32Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 120000);

  try {
    const response = await fetch(`${config.host}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        prompt: input,
        keep_alive: config.keepAlive ?? '30s',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const payload = (await response.json()) as { embedding?: number[] };

    if (!Array.isArray(payload.embedding) || payload.embedding.length === 0) {
      throw new Error('az ollama ures embeddinget adott vissza');
    }

    // az elso sikeres hivasbol megjegyezzuk a dimenziot
    if (detectedDim === 0) {
      detectedDim = payload.embedding.length;
    }

    return Float32Array.from(payload.embedding);
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// publikus api
// ----------------------------------------------------------------------------

/** egyetlen szoveg embeddingje */
export async function embedOne(text: string): Promise<Float32Array> {
  const cached = cacheGet(text);
  if (cached) return cached;

  const vector = await callEmbeddingApi(text);
  cacheSet(text, vector);

  return vector;
}

/**
 * tobb szoveg embeddingje.
 *
 * az ollama nem tud igazi batch-et, tehat sorosan hivjuk. viszont igy
 * kezben tudjuk tartani a terhelest, es kozben tudunk haladast jelezni.
 */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<EmbeddingResult> {
  const startedAt = Date.now();
  const vectors: Float32Array[] = [];

  try {
    for (let i = 0; i < texts.length; i++) {
      vectors.push(await embedOne(texts[i]));

      if (onProgress) {
        onProgress(i + 1, texts.length);
      }
    }

    return { ok: true, vectors, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      vectors,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * ellenorzi, hogy az embedding modell elerheto-e.
 *
 * ha nincs letoltve, konkret, masolhato parancsot adunk vissza --
 * ne a felhasznalonak kelljen kitalalnia, mit csinaljon.
 */
export async function ensureEmbeddingModel(): Promise<{
  ok: boolean;
  error?: string;
  command?: string;
  dimension?: number;
}> {
  try {
    const response = await fetch(`${config.host}/api/tags`);

    if (!response.ok) {
      return {
        ok: false,
        error: `az ollama nem elerheto (${config.host})`,
      };
    }

    const payload = (await response.json()) as {
      models?: { name: string }[];
    };

    const models = payload.models ?? [];
    const base = config.model.split(':')[0];

    const found = models.some(
      (m) => m.name === config.model || m.name.split(':')[0] === base,
    );

    if (!found) {
      return {
        ok: false,
        error: `a(z) ${config.model} embedding modell nincs letoltve`,
        command: `ollama pull ${config.model}`,
      };
    }

    // teszt hivas, hogy a dimenziot is megtudjuk
    const vector = await embedOne('teszt');

    return { ok: true, dimension: vector.length };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ----------------------------------------------------------------------------
// vektor muveletek
// ----------------------------------------------------------------------------

/**
 * koszinusz hasonlosag ket vektor kozott.
 * a sqlite-vec ezt maga is tudja, de a self-consistency osszehasonlitashoz
 * (F11) js oldalon is kell.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** a sqlite-vec Uint8Array-kent varja a vektort */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
