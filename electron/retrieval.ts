// ============================================================================
// vellum - retrieval.ts (F4)
// ============================================================================
// hibrid kereses: szemantikus (embedding) + kulcsszavas (fts5), rrf fuzioval.
//
// MIERT HIBRID es nem csak szemantikus:
// a tisztan szemantikus kereses elbukik a szokincs-elteresen. a felhasznalo
// azt irja, "toroljuk", a dokumentumban meg "visszateritjuk" szerepel.
// a tisztan kulcsszavas viszont a fogalmi egyezesen bukik el: a
// "gyartosor leallas" es a "termelesi vonal megallt" nem talalkozik.
//
// FONTOS KORLAT, amit tudni kell:
// a vektoros kereses mint memoria CSAK OLVASHATO. abban a pillanatban rossz
// eszkoz, amint egy korabban tarolt tenyt frissiteni vagy felulirni kell.
// ezert NEM helyettesiti a memory.json-t (F3), hanem kiegesziti:
//   - memory.json      = "ki vagyok es mit szeretek" -> szerkesztheto
//   - vektoros archivum = "mit beszeltunk eddig"      -> csak olvashato
// ============================================================================

import type { RetrievalHit, ChunkSourceType } from './shared';
import { RRF_K } from './shared';
import { getDb, isVectorSearchAvailable } from './db';
import { embedOne, vectorToBlob } from './embeddings';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface SearchOptions {
  /** vegso talalatszam. alap: 5 */
  limit?: number;
  /** hany jelolt jojjon be fuzio elott. alap: 30 */
  candidates?: number;
  /** csak ezekbol a forrasokbol keressunk */
  sourceTypes?: ChunkSourceType[];
  /** ha csak egy beszelgetesen belul keresunk */
  conversationId?: string;
  /** csak ennel frissebb chunkok */
  sinceMs?: number;
  /** ha true, csak fts5 kereses fut (gyorsabb, gepeles kozbeni keresesre) */
  keywordOnly?: boolean;
}

interface ChunkRow {
  id: number;
  source_type: string;
  source_id: string;
  conversation_id: string | null;
  text: string;
  created_at: number;
}

// ----------------------------------------------------------------------------
// fts5 elokeszites
// ----------------------------------------------------------------------------

/**
 * biztonsagossa teszi a keresokifejezest az fts5 szamara.
 *
 * az fts5-nek sajat lekerdezo nyelve van (AND, OR, NEAR, idezojel, csillag),
 * es ha a felhasznalo szovegeben van ilyen karakter, hibat dob. ezert
 * minden szot kulon idezojelbe teszunk, es OR kapcsolattal fuzzuk ossze.
 */
function toFtsQuery(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/["'*^:(){}[\]-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return '';

  // minden szo ele es moge idezojel, hogy literalkent kezelje.
  // a * a vegen prefix-kereses: a "gyart" megtalalja a "gyartosor"-t is,
  // ami a magyar ragozas miatt kifejezetten hasznos.
  return words.map((w) => `"${w}"*`).join(' OR ');
}

// ----------------------------------------------------------------------------
// kulcsszavas kereses
// ----------------------------------------------------------------------------

function sparseSearch(
  query: string,
  limit: number,
  filters: SearchOptions,
): { row: ChunkRow; rank: number }[] {
  const db = getDb();
  const ftsQuery = toFtsQuery(query);

  if (ftsQuery.length === 0) return [];

  const conditions: string[] = ['chunks_fts MATCH ?'];
  const params: unknown[] = [ftsQuery];

  if (filters.sourceTypes && filters.sourceTypes.length > 0) {
    const placeholders = filters.sourceTypes.map(() => '?').join(', ');
    conditions.push(`c.source_type IN (${placeholders})`);
    params.push(...filters.sourceTypes);
  }

  if (filters.conversationId) {
    conditions.push('c.conversation_id = ?');
    params.push(filters.conversationId);
  }

  if (filters.sinceMs) {
    conditions.push('c.created_at >= ?');
    params.push(filters.sinceMs);
  }

  params.push(limit);

  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.source_type, c.source_id, c.conversation_id,
                c.text, c.created_at
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE ${conditions.join(' AND ')}
         ORDER BY bm25(chunks_fts)
         LIMIT ?`,
      )
      .all(...params) as ChunkRow[];

    return rows.map((row, index) => ({ row, rank: index }));
  } catch {
    // az fts5 hibat dobhat egzotikus bemenetre. ilyenkor inkabb ures
    // eredmeny, mint osszeomlas.
    return [];
  }
}

// ----------------------------------------------------------------------------
// szemantikus kereses
// ----------------------------------------------------------------------------

async function denseSearch(
  query: string,
  limit: number,
  filters: SearchOptions,
): Promise<{ row: ChunkRow; rank: number; distance: number }[]> {
  if (!isVectorSearchAvailable()) return [];

  const db = getDb();

  let queryVector: Float32Array;
  try {
    queryVector = await embedOne(query);
  } catch {
    // ha az embedding modell nem elerheto, a kulcsszavas kereses meg mukodik
    return [];
  }

  try {
    // eloszor a knn talalatokat kerjuk le a vektortablabol,
    // aztan joinoljuk a chunk metaadatokkal
    const vecRows = db
      .prepare(
        `SELECT chunk_id, distance
         FROM chunks_vec
         WHERE embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(vectorToBlob(queryVector), limit) as {
      chunk_id: number;
      distance: number;
    }[];

    if (vecRows.length === 0) return [];

    const ids = vecRows.map((r) => r.chunk_id);
    const placeholders = ids.map(() => '?').join(', ');

    const conditions: string[] = [`c.id IN (${placeholders})`];
    const params: unknown[] = [...ids];

    if (filters.sourceTypes && filters.sourceTypes.length > 0) {
      const typePlaceholders = filters.sourceTypes.map(() => '?').join(', ');
      conditions.push(`c.source_type IN (${typePlaceholders})`);
      params.push(...filters.sourceTypes);
    }

    if (filters.conversationId) {
      conditions.push('c.conversation_id = ?');
      params.push(filters.conversationId);
    }

    if (filters.sinceMs) {
      conditions.push('c.created_at >= ?');
      params.push(filters.sinceMs);
    }

    const chunkRows = db
      .prepare(
        `SELECT c.id, c.source_type, c.source_id, c.conversation_id,
                c.text, c.created_at
         FROM chunks c
         WHERE ${conditions.join(' AND ')}`,
      )
      .all(...params) as ChunkRow[];

    const byId = new Map<number, ChunkRow>();
    for (const row of chunkRows) byId.set(row.id, row);

    // a vektortabla sorrendjet tartjuk meg, mert az a relevancia sorrend
    const result: { row: ChunkRow; rank: number; distance: number }[] = [];

    for (const vecRow of vecRows) {
      const row = byId.get(vecRow.chunk_id);
      if (!row) continue; // kiszurte valamelyik filter

      result.push({ row, rank: result.length, distance: vecRow.distance });
    }

    return result;
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// reciprocal rank fusion
// ----------------------------------------------------------------------------

/**
 * osszefesuli a ket talalati listat.
 *
 * a keplet:  score(d) = SZUM_lista  1 / (K + rank_lista(d))
 *
 * miert jo ez: nem kell normalizalni a pontszamokat. a bm25 pontszama es a
 * koszinusz tavolsag teljesen mas skala, osszehasonlithatatlanok. az rrf
 * viszont csak a SORRENDET nezi, ezert barmilyen ket listat ossze tud fuzni.
 *
 * a K=60 a szokasos ertek az irodalombol. ne talalj ki ujat.
 */
export function reciprocalRankFusion(
  lists: { key: number; rank: number }[][],
  k: number = RRF_K,
): Map<number, number> {
  const scores = new Map<number, number>();

  for (const list of lists) {
    for (const item of list) {
      const previous = scores.get(item.key) ?? 0;
      scores.set(item.key, previous + 1 / (k + item.rank));
    }
  }

  return scores;
}

// ----------------------------------------------------------------------------
// fo kereso fuggveny
// ----------------------------------------------------------------------------

export async function hybridSearch(
  query: string,
  options?: SearchOptions,
): Promise<RetrievalHit[]> {
  const limit = options?.limit ?? 5;
  const candidateCount = options?.candidates ?? 30;
  const filters = options ?? {};

  if (!query || query.trim().length === 0) return [];

  // a ket keresest parhuzamosan inditjuk
  const sparsePromise = Promise.resolve(
    sparseSearch(query, candidateCount, filters),
  );

  const densePromise = filters.keywordOnly
    ? Promise.resolve([])
    : denseSearch(query, candidateCount, filters);

  const [sparse, dense] = await Promise.all([sparsePromise, densePromise]);

  // ha egyik lista sem hozott semmit, nincs mit fuzionalni
  if (sparse.length === 0 && dense.length === 0) return [];

  const fused = reciprocalRankFusion([
    sparse.map((s) => ({ key: s.row.id, rank: s.rank })),
    dense.map((d) => ({ key: d.row.id, rank: d.rank })),
  ]);

  // osszegyujtjuk a sorokat es a reszpontszamokat
  const rowById = new Map<number, ChunkRow>();
  const sparseRankById = new Map<number, number>();
  const denseDistanceById = new Map<number, number>();

  for (const item of sparse) {
    rowById.set(item.row.id, item.row);
    sparseRankById.set(item.row.id, item.rank);
  }

  for (const item of dense) {
    rowById.set(item.row.id, item.row);
    denseDistanceById.set(item.row.id, item.distance);
  }

  const hits: RetrievalHit[] = [];

  for (const [chunkId, score] of fused.entries()) {
    const row = rowById.get(chunkId);
    if (!row) continue;

    const distance = denseDistanceById.get(chunkId);
    const sparseRank = sparseRankById.get(chunkId);

    hits.push({
      chunkId,
      text: row.text,
      sourceType: row.source_type as ChunkSourceType,
      sourceId: row.source_id,
      conversationId: row.conversation_id,
      // a tavolsagbol hasonlosagot csinalunk, hogy ertelmezhetobb legyen
      scoreDense: distance !== undefined ? 1 / (1 + distance) : 0,
      scoreSparse: sparseRank !== undefined ? 1 / (1 + sparseRank) : 0,
      scoreFused: score,
      createdAt: row.created_at,
    });
  }

  hits.sort((a, b) => b.scoreFused - a.scoreFused);

  return hits.slice(0, limit);
}

// ----------------------------------------------------------------------------
// chunk irasa
// ----------------------------------------------------------------------------

export interface StoreChunkInput {
  sourceType: ChunkSourceType;
  sourceId: string;
  conversationId: string | null;
  ord: number;
  text: string;
  tokenCount: number;
  embeddingModel: string;
  /** ha mar megvan az embedding, itt at lehet adni */
  vector?: Float32Array;
}

/**
 * elment egy chunkot es (ha van) a vektorat.
 * ha nincs vektor, csak a kulcsszavas kereses fogja megtalalni.
 */
export function storeChunk(input: StoreChunkInput): number {
  const db = getDb();

  const result = db
    .prepare(
      `INSERT INTO chunks
        (source_type, source_id, conversation_id, ord, text,
         token_count, created_at, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sourceType,
      input.sourceId,
      input.conversationId,
      input.ord,
      input.text,
      input.tokenCount,
      Date.now(),
      input.embeddingModel,
    );

  const chunkId = Number(result.lastInsertRowid);

  if (input.vector && isVectorSearchAvailable()) {
    try {
      db.prepare(
        'INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)',
      ).run(chunkId, vectorToBlob(input.vector));
    } catch {
      // ha a vektortabla dimenzioja nem stimmel, ne omoljon ossze az
      // egesz indexeles. a chunk igy is kereshetu marad kulcsszoval.
    }
  }

  return chunkId;
}

/** torli egy forras osszes chunkjat (pl. ujraindexeles elott) */
export function deleteChunksBySource(
  sourceType: ChunkSourceType,
  sourceId: string,
): number {
  const db = getDb();

  const ids = db
    .prepare('SELECT id FROM chunks WHERE source_type = ? AND source_id = ?')
    .all(sourceType, sourceId) as { id: number }[];

  if (ids.length === 0) return 0;

  if (isVectorSearchAvailable()) {
    const placeholders = ids.map(() => '?').join(', ');
    try {
      db.prepare(
        `DELETE FROM chunks_vec WHERE chunk_id IN (${placeholders})`,
      ).run(...ids.map((r) => r.id));
    } catch {
      // ha nincs vektortabla, nincs mit torolni
    }
  }

  const result = db
    .prepare('DELETE FROM chunks WHERE source_type = ? AND source_id = ?')
    .run(sourceType, sourceId);

  return result.changes;
}

// ----------------------------------------------------------------------------
// talalatok formazasa a promptba
// ----------------------------------------------------------------------------

/**
 * a talalatokat adatkeretbe csomagolja, hogy a modell tudja:
 * ezek ADATOK, nem utasitasok.
 */
export function formatHitsForPrompt(
  hits: RetrievalHit[],
  frame: { open: string; close: string },
  labeler?: (hit: RetrievalHit, index: number) => string,
): string {
  if (hits.length === 0) return '';

  const blocks = hits.map((hit, index) => {
    const label = labeler
      ? labeler(hit, index)
      : `[${new Date(hit.createdAt).toISOString().slice(0, 10)}]`;

    return `${label}\n${hit.text}`;
  });

  return [frame.open, blocks.join('\n\n'), frame.close].join('\n');
}
