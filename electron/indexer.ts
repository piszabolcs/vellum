// ============================================================================
// vellum - indexer.ts (F4)
// ============================================================================
// hatter-indexelo sor.
//
// A LEGFONTOSABB SZABALY: az indexeles SOHA nem blokkolhatja a chatet.
//
// miert: az embedding modell betoltese es a kotegek futtatasa masodpercekbe
// kerul. ha ez a valaszadas kozben tortenne, a felhasznalo azt latna, hogy
// az app "megall" -- ami sokkal rosszabb elmeny, mint ha egy regi
// beszelgetes kicsit kesobb valik kereshetove.
//
// ezert:
//   - a feladatok sorban allnak
//   - a sor csak akkor dolgozik, ha nincs folyamatban chat-valasz
//   - egy koteg utan mindig visszaadjuk a vezerlest az event loopnak
// ============================================================================

import type { ChunkSourceType } from './shared';
import { chunkText, chunkMessage } from './chunker';
import { embedBatch } from './embeddings';
import { storeChunk, deleteChunksBySource } from './retrieval';
import { isVectorSearchAvailable } from './db';

// ----------------------------------------------------------------------------
// feladat tipusok
// ----------------------------------------------------------------------------

interface IndexJob {
  id: string;
  sourceType: ChunkSourceType;
  sourceId: string;
  conversationId: string | null;
  text: string;
  /** uzenetnel a szerep, hogy bekerulhessen a chunk szovegebe */
  role?: 'user' | 'assistant';
  createdAt: number;
}

export interface IndexerConfig {
  embeddingModel: string;
  chunkSizeTokens: number;
  chunkOverlapTokens: number;
  /** hany chunkot embeddeljunk egyszerre */
  batchSize: number;
}

let config: IndexerConfig = {
  embeddingModel: 'bge-m3',
  chunkSizeTokens: 512,
  chunkOverlapTokens: 64,
  batchSize: 16,
};

export function configureIndexer(next: Partial<IndexerConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

const queue: IndexJob[] = [];
let running = false;
/** ha true, a chat valaszol eppen, tehat nem indexelunk */
let paused = false;

let stats = {
  processed: 0,
  failed: 0,
  chunksCreated: 0,
};

export interface IndexerStatus {
  queueLength: number;
  running: boolean;
  paused: boolean;
  processed: number;
  failed: number;
  chunksCreated: number;
  /** eppen mit dolgoz fel */
  currentJob: string | null;
}

let currentJobLabel: string | null = null;

export function getIndexerStatus(): IndexerStatus {
  return {
    queueLength: queue.length,
    running,
    paused,
    processed: stats.processed,
    failed: stats.failed,
    chunksCreated: stats.chunksCreated,
    currentJob: currentJobLabel,
  };
}

/**
 * a modelManager hivja, amikor chat-valasz indul vagy vegzodik.
 *
 * ez az a "zold jelzes", ami miatt az indexeles nem szoritja ki a
 * chat modellt a memoriabol.
 */
export function setPaused(value: boolean): void {
  paused = value;

  if (!value && queue.length > 0 && !running) {
    // amikor felszabadul, magatol folytatja
    void processQueue();
  }
}

// ----------------------------------------------------------------------------
// sorba allitas
// ----------------------------------------------------------------------------

export function enqueueMessage(
  messageId: string,
  conversationId: string,
  content: string,
  role: 'user' | 'assistant',
): void {
  // nagyon rovid uzeneteket nem erdemes indexelni ("ok", "koszi")
  if (content.trim().length < 40) return;

  queue.push({
    id: `msg_${messageId}`,
    sourceType: 'message',
    sourceId: messageId,
    conversationId,
    text: content,
    role,
    createdAt: Date.now(),
  });

  void processQueue();
}

export function enqueueArtifact(
  artifactId: string,
  conversationId: string | null,
  text: string,
  sourceType: ChunkSourceType = 'web',
): void {
  queue.push({
    id: `art_${artifactId}`,
    sourceType,
    sourceId: artifactId,
    conversationId,
    text,
    createdAt: Date.now(),
  });

  void processQueue();
}

// ----------------------------------------------------------------------------
// feldolgozas
// ----------------------------------------------------------------------------

async function processQueue(): Promise<void> {
  if (running || paused || queue.length === 0) return;

  running = true;

  try {
    while (queue.length > 0 && !paused) {
      const job = queue.shift();
      if (!job) break;

      currentJobLabel = `${job.sourceType}: ${job.sourceId}`;

      try {
        await processJob(job);
        stats.processed++;
      } catch {
        stats.failed++;
      }

      currentJobLabel = null;

      // visszaadjuk a vezerlest az event loopnak, hogy a felulet
      // ne fagyjon be
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    running = false;
    currentJobLabel = null;
  }
}

async function processJob(job: IndexJob): Promise<void> {
  // ha ezt a forrast mar indexeltuk, eloszor toroljuk a regi chunkokat
  deleteChunksBySource(job.sourceType, job.sourceId);

  const chunks =
    job.role !== undefined
      ? chunkMessage(job.text, job.role, {
          targetTokens: config.chunkSizeTokens,
          overlapTokens: config.chunkOverlapTokens,
        })
      : chunkText(job.text, {
          targetTokens: config.chunkSizeTokens,
          overlapTokens: config.chunkOverlapTokens,
        });

  if (chunks.length === 0) return;

  // az embeddingeket kotegelve keszitjuk
  let vectors: Float32Array[] = [];

  if (isVectorSearchAvailable()) {
    const result = await embedBatch(chunks.map((c) => c.text));

    if (result.ok) {
      vectors = result.vectors;
    }
    // ha az embedding elbukik, a chunkokat akkor is elmentjuk --
    // a kulcsszavas kereses igy is megtalalja oket
  }

  for (let i = 0; i < chunks.length; i++) {
    storeChunk({
      sourceType: job.sourceType,
      sourceId: job.sourceId,
      conversationId: job.conversationId,
      ord: chunks[i].ord,
      text: chunks[i].text,
      tokenCount: chunks[i].tokenCount,
      embeddingModel: config.embeddingModel,
      vector: vectors[i],
    });

    stats.chunksCreated++;
  }
}

// ----------------------------------------------------------------------------
// teljes ujraindexeles
// ----------------------------------------------------------------------------

export interface ReindexProgress {
  total: number;
  done: number;
  currentLabel: string;
}

/**
 * ujraindexeli az osszes beszelgetest.
 *
 * ez akkor kell, ha az embedding modell valtozott -- olyankor a vektorok
 * dimenzioja mas lesz, es a regi index hasznalhatatlan.
 *
 * a legfrissebb beszelgetesektol visszafele haladunk, mert azok a
 * legvaloszinubben keresettek.
 */
export async function reindexAll(
  onProgress?: (progress: ReindexProgress) => void,
): Promise<{ ok: boolean; indexed: number; error?: string }> {
  try {
    const { listConversations, getMessages } = await import('./conversations');

    const conversations = listConversations({
      limit: 1000,
      includeArchived: true,
    });

    let done = 0;
    let indexed = 0;

    for (const conversation of conversations) {
      const messages = getMessages(conversation.id);

      for (const message of messages) {
        if (message.isError) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        if (message.content.trim().length < 40) continue;

        queue.push({
          id: `msg_${message.id}`,
          sourceType: 'message',
          sourceId: message.id,
          conversationId: conversation.id,
          text: message.content,
          role: message.role,
          createdAt: Date.now(),
        });

        indexed++;
      }

      done++;

      if (onProgress) {
        onProgress({
          total: conversations.length,
          done,
          currentLabel: conversation.title || 'névtelen beszélgetés',
        });
      }
    }

    // a sor feldolgozasat elinditjuk, de nem varjuk meg
    void processQueue();

    return { ok: true, indexed };
  } catch (error) {
    return {
      ok: false,
      indexed: 0,
      error: error instanceof Error ? error.message : 'az újraindexelés nem sikerült',
    };
  }
}

/** torli a sort (pl. ha embedding modellt valtunk menet kozben) */
export function clearQueue(): void {
  queue.length = 0;
  stats = { processed: 0, failed: 0, chunksCreated: 0 };
}
