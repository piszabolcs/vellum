// ============================================================================
// vellum - reranker.ts (F8)
// ============================================================================
// ujrarangsorolas: a legjobb megterulesu lepes az egesz retrieval-lancban.
//
// MIERT KELL: az embedding modell (bi-encoder) a kerdest es a dokumentumot
// KULON-KULON kodolja, sosem latjak egymast. a reranker (cross-encoder) a
// kettot EGYUTT olvassa be, igy minden kerdes-token minden dokumentum-tokenre
// figyelhet.
//
// TANULSAGOS ESET: valaki hetekig a chunkolast, az embedding modellt es a
// promptot hibaztatta, mire kiderult, hogy a helyes darab OTT VOLT a
// kontextusban, csak a negyedik-otodik helyen -- es a modell a folotte levo
// kevesbe relevans darabok alatt eltemetve nem adott neki eleg sulyt.
// vagyis nem a recall volt a baj, hanem az ELSO POZICIO PONTOSSAGA.
//
// KET MEGVALOSITAS:
//   A) ollama-alapu pontozas (ez az alapertelmezes) -- nulla uj fuggoseg
//   B) igazi cross-encoder (bge-reranker-v2-m3) onnx-szel -- pontosabb
//
// az interfesz ugy van megirva, hogy a B) beilleszteheto legyen egyetlen
// implementacio-csereevel.
// ============================================================================

import type { RetrievalHit } from './shared';
import { ollamaOneShot } from './ollamaOneShot';
import {
  RerankScoresSchema,
  RerankScoresJsonSchema,
  type RerankScoresParsed,
} from './schemas';

// ----------------------------------------------------------------------------
// interfesz
// ----------------------------------------------------------------------------

export interface Reranker {
  name: string;
  rerank(
    query: string,
    candidates: RetrievalHit[],
    topK: number,
  ): Promise<RetrievalHit[]>;
}

export interface RerankerConfig {
  host: string;
  model: string;
  numCtx: number;
  /** hany jelolt menjen egy hivasban. alap: 10 */
  batchSize: number;
  timeoutMs: number;
}

let config: RerankerConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 8192,
  batchSize: 10,
  timeoutMs: 60000,
};

export function configureReranker(next: Partial<RerankerConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// A) ollama-alapu pontozo
// ----------------------------------------------------------------------------

/**
 * a fo modellel pontoztatja a jelolteket 0-10 skalan.
 *
 * a minta ugyanaz, mint egy igazi cross-encodernel: pontonkenti
 * (kerdes, chunk) pontozas, majd ujrarendezes. csak lassabb es kevesbe
 * pontos -- cserebe nulla uj fuggoseg.
 */
export class OllamaScoringReranker implements Reranker {
  readonly name = 'ollama-scoring';

  async rerank(
    query: string,
    candidates: RetrievalHit[],
    topK: number,
  ): Promise<RetrievalHit[]> {
    if (candidates.length === 0) return [];

    // ha kevesebb jelolt van, mint amennyi kell, nincs mit rangsorolni
    if (candidates.length <= topK) return candidates;

    const scores = new Map<number, number>();

    // kotegelve dolgozunk, hogy ne legyen tul hosszu egy-egy prompt
    for (let start = 0; start < candidates.length; start += config.batchSize) {
      const batch = candidates.slice(start, start + config.batchSize);
      const batchScores = await this.scoreBatch(query, batch);

      for (const [localIndex, score] of batchScores.entries()) {
        const hit = batch[localIndex];
        if (hit) scores.set(hit.chunkId, score);
      }
    }

    // rendezes a pontszamok szerint.
    // ha egy jelolt nem kapott pontot (hibas valasz miatt), a fuzios
    // pontszamat hasznaljuk tartaleknak -- igy nem esik ki teljesen.
    const ranked = [...candidates].sort((a, b) => {
      const scoreA = scores.get(a.chunkId) ?? a.scoreFused * 5;
      const scoreB = scores.get(b.chunkId) ?? b.scoreFused * 5;
      return scoreB - scoreA;
    });

    return ranked.slice(0, topK);
  }

  private async scoreBatch(
    query: string,
    batch: RetrievalHit[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();

    const system = [
      'Te egy relevancia-értékelő vagy.',
      'A feladatod: eldönteni, hogy egy szövegrészlet mennyire válaszolja meg',
      'a kérdést. NEM kell válaszolnod a kérdésre.',
      '',
      'Pontozás 0-tól 10-ig:',
      '- 0-2: teljesen irreleváns',
      '- 3-5: érinti a témát, de nem válaszol a kérdésre',
      '- 6-8: hasznos információt tartalmaz a kérdéshez',
      '- 9-10: közvetlenül megválaszolja a kérdést',
      '',
      'Légy szigorú. A "témába vág" még nem jelenti azt, hogy releváns.',
    ].join('\n');

    const blocks = batch.map((hit, index) => {
      // levagjuk a chunkot, hogy a pontozo prompt ne legyen oriasi
      const excerpt =
        hit.text.length > 600 ? hit.text.slice(0, 600) + '...' : hit.text;

      return `[${index}]\n${excerpt}`;
    });

    const user = [
      `KÉRDÉS: ${query}`,
      '',
      'SZÖVEGRÉSZLETEK:',
      '---',
      blocks.join('\n\n'),
      '---',
      '',
      'Adj minden részletnek egy pontszámot az indexe alapján.',
    ].join('\n');

    const response = await ollamaOneShot<RerankScoresParsed>(
      {
        host: config.host,
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        schema: RerankScoresJsonSchema,
        numCtx: config.numCtx,
        temperature: 0,
        think: false,
        timeoutMs: config.timeoutMs,
      },
      (value) => RerankScoresSchema.parse(value),
    );

    if (!response.ok || !response.data) {
      // ha a pontozas elbukik, ures terkeppel terunk vissza, es a hivo
      // fel a fuzios pontszamokat fogja hasznalni
      return result;
    }

    for (const item of response.data.scores) {
      if (item.index >= 0 && item.index < batch.length) {
        result.set(item.index, item.score);
      }
    }

    return result;
  }
}

// ----------------------------------------------------------------------------
// B) hely az igazi cross-encodernek
// ----------------------------------------------------------------------------

/**
 * ide jon majd a bge-reranker-v2-m3, ha kell.
 *
 * a modell tobbnyelvu terhelesre a jelenlegi legjobb nyilt sulyu valasztas,
 * ami nalunk a magyar miatt szamit. transformers.js-szel, onnx futtatassal
 * lehetne beilleszteni a main processbe.
 *
 * a merheto nyereseg: 5-15 pont ndcg@10 vagy recall@5 a nehez kerdeseken,
 * korulbelul 50-150 ms plusz keslelteteseert.
 */
export class NoopReranker implements Reranker {
  readonly name = 'noop';

  async rerank(
    _query: string,
    candidates: RetrievalHit[],
    topK: number,
  ): Promise<RetrievalHit[]> {
    return candidates.slice(0, topK);
  }
}

// ----------------------------------------------------------------------------
// valaszto
// ----------------------------------------------------------------------------

let activeReranker: Reranker = new OllamaScoringReranker();

export function setReranker(reranker: Reranker): void {
  activeReranker = reranker;
}

export function getReranker(): Reranker {
  return activeReranker;
}

/**
 * kenyelmi fuggveny: rerankeli a talalatokat az aktiv rerankerrel.
 *
 * ha a rerank barmi okbol elbukik, az eredeti sorrendet adjuk vissza.
 * fontos, hogy egy rerank-hiba ne vigye el az egesz keresest.
 */
export async function rerankHits(
  query: string,
  hits: RetrievalHit[],
  topK: number,
  enabled = true,
): Promise<{ hits: RetrievalHit[]; reranked: boolean; durationMs: number }> {
  const startedAt = Date.now();

  if (!enabled || hits.length <= topK) {
    return {
      hits: hits.slice(0, topK),
      reranked: false,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    const reranked = await activeReranker.rerank(query, hits, topK);

    return {
      hits: reranked,
      reranked: true,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      hits: hits.slice(0, topK),
      reranked: false,
      durationMs: Date.now() - startedAt,
    };
  }
}
