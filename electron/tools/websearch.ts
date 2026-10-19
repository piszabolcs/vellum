// ============================================================================
// vellum - tools/websearch.ts (F8)
// ============================================================================
// melykereses: tobb lekerdezes -> rrf fuzio -> oldalletoltes -> chunkolas
// -> rerank -> csak a legjobb 3-5 bekezdes megy a kontextusba.
//
// a haveromban csak a snippetek mentek be, oldalletoltes nelkul. az
// biztonsagos volt, de sekely: a valasz gyakran a cikk harmadik
// bekezdeseben van, ami sosem jutott el a modellhez.
//
// A KETNYELVU KERESES: a router magyar ES angol keresokifejezest is ad.
// az angol nyelvu muszaki tartalom a neten nagysagrendekkel bovebb, es a
// talalatokat rrf-fel fesuljuk ossze -- onnantol a nyelv nem szamit.
// ez NEM ugyanaz, mint a chunkok forditasa embedding elott: ott az
// aszimmetria elrontana a keresest, itt viszont csak egy lekerdezesrol
// van szo, aminek az eredmenye nyelvfuggetlenul dolgozodik fel.
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';
import { DATA_FRAMES, RRF_K, frameAsData } from '../shared';
import { fetchPages } from '../fetcher';
import { extractContent } from '../extractor';
import { chunkText } from '../chunker';
import { rerankHits } from '../reranker';
import { estimateTokens } from '../tokenizer';
import type { RetrievalHit } from '../shared';

// ----------------------------------------------------------------------------
// konfiguracio
// ----------------------------------------------------------------------------

export interface WebSearchConfig {
  /** hany oldalt toltsunk le. alap: 4 */
  maxPagesToFetch: number;
  /** melykereses be van-e kapcsolva */
  deepSearchEnabled: boolean;
  rerankEnabled: boolean;
  respectRobotsTxt: boolean;
  /** hany chunk menjen vegul a kontextusba. alap: 5 */
  finalChunkCount: number;
}

let config: WebSearchConfig = {
  maxPagesToFetch: 4,
  deepSearchEnabled: true,
  rerankEnabled: true,
  respectRobotsTxt: true,
  finalChunkCount: 5,
};

export function configureWebSearch(next: Partial<WebSearchConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// duckduckgo kereses
// ----------------------------------------------------------------------------

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

/** a ddg atiranyito linkjeibol kiszedi a valos url-t */
function resolveDuckDuckGoUrl(href: string): string {
  // formatum: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
  const match = href.match(/[?&]uddg=([^&]+)/);

  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return href;
    }
  }

  if (href.startsWith('//')) return `https:${href}`;

  return href;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * egyetlen kereses a duckduckgo html vegpontjan.
 * kulcs nelkuli, tehat nincs api limit es nincs koltseg.
 */
export async function searchDuckDuckGo(
  query: string,
  limit = 10,
): Promise<{ ok: boolean; results: SearchResultItem[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
      body: new URLSearchParams({ q: query }).toString(),
    });

    if (!response.ok) {
      clearTimeout(timer);
      return {
        ok: false,
        results: [],
        error: `a kereső HTTP ${response.status} hibát adott`,
      };
    }

    // the deadline also covers the body, not only the headers
    const html = await response.text();
    clearTimeout(timer);
    const results: SearchResultItem[] = [];

    // a talalatok a result__body osztalyu blokkokban vannak
    const blockPattern = /<div class="result__body">([\s\S]*?)<\/div>\s*<\/div>/g;

    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(html)) !== null && results.length < limit) {
      const block = match[1];

      const linkMatch = block.match(
        /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
      );

      if (!linkMatch) continue;

      const url = resolveDuckDuckGoUrl(decodeHtmlEntities(linkMatch[1]));
      const title = decodeHtmlEntities(stripTags(linkMatch[2]));

      const snippetMatch = block.match(
        /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
      );

      const snippet = snippetMatch
        ? decodeHtmlEntities(stripTags(snippetMatch[1]))
        : '';

      if (url.startsWith('http') && title.length > 0) {
        results.push({ title, url, snippet });
      }
    }

    return { ok: true, results };
  } catch (error) {
    clearTimeout(timer);

    const isAbort = error instanceof Error && error.name === 'AbortError';

    return {
      ok: false,
      results: [],
      error: isAbort
        ? 'a keresés időtúllépés miatt megszakadt'
        : error instanceof Error
          ? error.message
          : 'ismeretlen keresési hiba',
    };
  }
}

// ----------------------------------------------------------------------------
// tobb lekerdezes + rrf fuzio
// ----------------------------------------------------------------------------

/**
 * tobb keresokifejezessel keres, es a talalati listakat rrf-fel fesuli ossze.
 *
 * miert rrf: a kulonbozo lekerdezesek talalati listai osszehasonlithatatlan
 * pontszamokat adnak. az rrf viszont csak a SORRENDET nezi, ezert barmilyen
 * ket listat ossze tud fuzni -- akar magyar es angol talalatokat is.
 */
export async function multiQuerySearch(
  queries: string[],
  limitPerQuery = 8,
): Promise<{ ok: boolean; results: SearchResultItem[]; error?: string }> {
  if (queries.length === 0) {
    return { ok: false, results: [], error: 'nincs keresőkifejezés' };
  }

  // parhuzamosan futtatjuk a kereseseket
  const searches = await Promise.all(
    queries.slice(0, 4).map((query) => searchDuckDuckGo(query, limitPerQuery)),
  );

  const successful = searches.filter((s) => s.ok);

  if (successful.length === 0) {
    return {
      ok: false,
      results: [],
      error: searches[0]?.error ?? 'egyik keresés sem sikerült',
    };
  }

  // rrf fuzio az url-ek alapjan
  const scores = new Map<string, number>();
  const itemByUrl = new Map<string, SearchResultItem>();

  for (const search of successful) {
    for (let rank = 0; rank < search.results.length; rank++) {
      const item = search.results[rank];

      const previous = scores.get(item.url) ?? 0;
      scores.set(item.url, previous + 1 / (RRF_K + rank));

      // az elso elofordulas metaadatait tartjuk meg
      if (!itemByUrl.has(item.url)) {
        itemByUrl.set(item.url, item);
      }
    }
  }

  const merged = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => itemByUrl.get(url))
    .filter((item): item is SearchResultItem => item !== undefined);

  return { ok: true, results: merged };
}

// ----------------------------------------------------------------------------
// melykereses
// ----------------------------------------------------------------------------

export interface DeepSearchResult {
  ok: boolean;
  /** a vegso, rerankelt chunkok, amik a kontextusba mennek */
  chunks: { text: string; url: string; title: string }[];
  /** a teljes letoltott szoveg, ami artifactba megy */
  fullTexts: { url: string; title: string; text: string }[];
  error?: string;
}

/**
 * a teljes melykereso folyamat.
 *
 * a lepesek:
 *   1. tobb lekerdezes -> rrf fuzio
 *   2. a legjobb 3-5 oldal letoltese
 *   3. readability kivonatolas
 *   4. chunkolas
 *   5. rerank az EREDETI kerdessel (nem a keresokifejezessel!)
 *   6. csak a legjobb 3-5 chunk megy a kontextusba
 */
export async function deepSearch(
  originalQuestion: string,
  queries: string[],
): Promise<DeepSearchResult> {
  // 1-2. kereses es fuzio
  const search = await multiQuerySearch(queries);

  if (!search.ok || search.results.length === 0) {
    return {
      ok: false,
      chunks: [],
      fullTexts: [],
      error: search.error ?? 'nincs találat',
    };
  }

  // ha a melykereses ki van kapcsolva, csak a snippeteket adjuk vissza.
  // ez a haverom regi viselkedese, biztonsagos tartalek.
  if (!config.deepSearchEnabled) {
    return {
      ok: true,
      chunks: search.results.slice(0, 5).map((r) => ({
        text: r.snippet,
        url: r.url,
        title: r.title,
      })),
      fullTexts: [],
    };
  }

  // 3. oldalletoltes
  const urls = search.results.slice(0, config.maxPagesToFetch).map((r) => r.url);

  const fetched = await fetchPages(urls, {
    respectRobotsTxt: config.respectRobotsTxt,
  });

  // 4. kivonatolas es chunkolas
  const allChunks: RetrievalHit[] = [];
  const fullTexts: { url: string; title: string; text: string }[] = [];
  const metaByChunkId = new Map<number, { url: string; title: string }>();

  let chunkIdCounter = 1;

  for (const { url, result } of fetched) {
    if (!result.ok || !result.html) continue;

    const extracted = extractContent(result.html);

    if (!extracted.ok || extracted.text.length < 100) continue;

    const searchItem = search.results.find((r) => r.url === url);
    const title = extracted.title || searchItem?.title || url;

    fullTexts.push({ url, title, text: extracted.text });

    const chunks = chunkText(extracted.text, {
      targetTokens: 512,
      overlapTokens: 64,
    });

    for (const chunk of chunks) {
      const id = chunkIdCounter++;

      metaByChunkId.set(id, { url, title });

      allChunks.push({
        chunkId: id,
        text: chunk.text,
        sourceType: 'web',
        sourceId: url,
        conversationId: null,
        scoreDense: 0,
        scoreSparse: 0,
        // kezdeti pontszam: a korabbi chunkok elonyt kapnak, mert a
        // cikkek eleje altalaban informativabb
        scoreFused: 1 / (1 + chunk.ord),
        createdAt: Date.now(),
      });
    }
  }

  if (allChunks.length === 0) {
    // egyik oldalt sem sikerult letolteni -> visszaesunk a snippetekre
    return {
      ok: true,
      chunks: search.results.slice(0, 5).map((r) => ({
        text: r.snippet,
        url: r.url,
        title: r.title,
      })),
      fullTexts: [],
    };
  }

  // 5. rerank -- FONTOS: az EREDETI kerdessel, nem a keresokifejezessel.
  // a keresokifejezes a keresohoz volt optimalizalva, de a relevanciat
  // a felhasznalo valodi kerdesehez kell merni.
  const { hits } = await rerankHits(
    originalQuestion,
    allChunks,
    config.finalChunkCount,
    config.rerankEnabled,
  );

  // 6. vegso osszeallitas
  const chunks = hits.map((hit) => {
    const meta = metaByChunkId.get(hit.chunkId);

    return {
      text: hit.text,
      url: meta?.url ?? hit.sourceId,
      title: meta?.title ?? '',
    };
  });

  return { ok: true, chunks, fullTexts };
}

// ----------------------------------------------------------------------------
// tool definicio
// ----------------------------------------------------------------------------

const WebSearchArgsSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('A keresőkifejezés. Ne a teljes kérdést add meg, hanem kulcsszavakat.'),
  query_en: z
    .string()
    .optional()
    .describe(
      'Angol keresőkifejezés. Műszaki témánál MINDIG add meg, mert az angol ' +
        'nyelvű tartalom sokkal bővebb.',
    ),
});

type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

export const webSearchTool: ToolDef<WebSearchArgs> = {
  name: 'web_search',
  category: 'search',
  shortDescription: 'webes keresés és oldalletöltés friss információhoz',
  description: [
    'Keres a weben, letölti a legrelevánsabb oldalakat, és visszaadja a',
    'kérdéshez legjobban illő részleteket forrásmegjelöléssel.',
    'KÖTELEZŐ használnod minden időben változó tényhez: árak, verziószámok,',
    'hírek, időjárás, "legújabb" vagy "most" típusú kérdések.',
    'Műszaki témánál adj meg angol keresőkifejezést is a query_en mezőben.',
  ].join(' '),
  schema: WebSearchArgsSchema,
  jsonSchema: zodToJsonSchema(WebSearchArgsSchema, {
    name: 'WebSearchArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: true,
  maxCallsPerTurn: 3,
  priority: 100,

  async execute(args: WebSearchArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    if (!ctx.settings.webSearchEnabled) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          'a webes keresés ki van kapcsolva a beállításokban, ' +
          'válaszolj a saját tudásodból, és jelezd, hogy nem tudtál keresni',
        durationMs: Date.now() - startedAt,
      };
    }

    const queries = [args.query];
    if (args.query_en && args.query_en.trim().length > 0) {
      queries.push(args.query_en);
    }

    const result = await deepSearch(args.query, queries);

    if (!result.ok || result.chunks.length === 0) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          result.error ?? 'a keresés nem hozott értékelhető találatot',
        durationMs: Date.now() - startedAt,
      };
    }

    // Downloaded page text goes back as a role:'tool' message, which the
    // renderer's prompt builder never sees -- so the data frame is applied
    // here, on the real path.
    const blocks = result.chunks.map((chunk, index) => {
      const id = `F${index + 1}`;
      return `[${id}] ${chunk.title}\n${chunk.url}\n${chunk.text}`;
    });

    const forModel = frameAsData(DATA_FRAMES.webSearch, blocks.join('\n\n'));

    // a teljes letoltott szoveget artifactba tesszuk, hogy visszakerheto legyen
    let artifactId: string | undefined;

    if (result.fullTexts.length > 0) {
      try {
        const { storeArtifact } = await import('../artifacts');

        const combined = result.fullTexts
          .map((t) => `## ${t.title}\n${t.url}\n\n${t.text}`)
          .join('\n\n---\n\n');

        const artifact = await storeArtifact({
          kind: 'websearch',
          title: `Keresés: ${args.query}`,
          url: null,
          body: combined,
          conversationId: ctx.conversationId,
        });

        artifactId = artifact.id;
      } catch {
        // ha az artifact mentes elbukik, a kereses eredmenye meg jo
      }
    }

    return {
      ok: true,
      data: {
        chunkCount: result.chunks.length,
        pagesFetched: result.fullTexts.length,
        sources: result.chunks.map((c) => ({ url: c.url, title: c.title })),
      },
      forModel:
        artifactId !== undefined
          ? `${forModel}\n\n[A teljes letöltött szöveg: read_artifact(${artifactId})]`
          : forModel,
      artifactId,
      durationMs: Date.now() - startedAt,
    };
  },
};

// ----------------------------------------------------------------------------
// statisztika
// ----------------------------------------------------------------------------

export function estimateSearchCost(chunks: { text: string }[]): number {
  return chunks.reduce((sum, chunk) => sum + estimateTokens(chunk.text), 0);
}
