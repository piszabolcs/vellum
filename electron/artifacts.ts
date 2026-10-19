// ============================================================================
// vellum - artifacts.ts (F5)
// ============================================================================
// nagy tool-kimenetek offloadja.
//
// A LENYEG: a kontextusablak nem archivum, hanem iroasztal. ha tele van
// kacattal, a modell nem attol lesz okosabb, hogy tobb papir van elotte,
// hanem attol butabb, hogy nem talalja koztuk a lenyeget.
//
// a haromlepcsos strategiabol ez az ELSO lepcso, es ezt kell eloszor
// kimeriteni, mert VESZTESEGMENTES: a teljes tartalom megmarad lemezen,
// a modell barmikor visszakerheti.
//
// csak ha ez nem eleg, jon a compaction (masodik lepcso), ami mar
// veszteseges.
// ============================================================================

import { randomUUID } from 'node:crypto';

import type { Artifact, ArtifactKind } from './shared';
import { getDb } from './db';
import { enqueueArtifact } from './indexer';
import { estimateTokens } from './tokenizer';
import { oneShotSimple } from './ollamaOneShot';
import {
  ArtifactSummarySchema,
  ArtifactSummaryJsonSchema,
  type ArtifactSummaryParsed,
} from './schemas';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface StoreArtifactInput {
  kind: ArtifactKind;
  title: string | null;
  url: string | null;
  body: string;
  conversationId: string | null;
}

export interface OffloadConfig {
  host: string;
  model: string;
  numCtx: number;
  /** e folott offloadolunk. alap: 600 token */
  thresholdTokens: number;
}

let config: OffloadConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 32768,
  thresholdTokens: 600,
};

export function configureArtifacts(next: Partial<OffloadConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// sor -> objektum
// ----------------------------------------------------------------------------

interface ArtifactRow {
  id: string;
  kind: string;
  title: string | null;
  url: string | null;
  summary: string;
  body: string;
  created_at: number;
  conversation_id: string | null;
  bytes: number;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    kind: row.kind as ArtifactKind,
    title: row.title,
    url: row.url,
    summary: row.summary,
    body: row.body,
    createdAt: row.created_at,
    conversationId: row.conversation_id,
    bytes: row.bytes,
  };
}

// ----------------------------------------------------------------------------
// osszefoglalo keszitese
// ----------------------------------------------------------------------------

/**
 * rovid osszefoglalot keszit a nagy tartalombol.
 *
 * ez megy a kontextusba a teljes szoveg helyett. ha a modell tobbet akar
 * tudni, a read_artifact eszkozzel visszakerheti.
 */
async function buildSummary(
  body: string,
  kind: ArtifactKind,
  title: string | null,
): Promise<{ summary: string; keyPoints: string[] }> {
  // a bemenetet levagjuk, hogy az osszefoglalo hivas maga se legyen oriasi
  const excerpt = body.length > 6000 ? body.slice(0, 6000) + '\n[...]' : body;

  const kindLabel: Record<ArtifactKind, string> = {
    websearch: 'webes keresési találatok',
    webpage: 'egy weboldal tartalma',
    file: 'egy fájl tartalma',
    tool_output: 'egy eszköz kimenete',
  };

  const system = [
    'Te egy tömörítő segéd vagy.',
    'A feladatod: rövid, tényszerű összefoglalót írni a kapott tartalomról.',
    'Ne értékelj, ne kommentálj, csak foglald össze.',
    'Magyarul írj.',
  ].join(' ');

  const user = [
    `Az alábbi ${kindLabel[kind]}${title ? ` (${title})` : ''}.`,
    'Írj róla egy 2-3 mondatos összefoglalót, és emelj ki legfeljebb 5 kulcspontot.',
    '',
    '---',
    excerpt,
    '---',
  ].join('\n');

  const result = await oneShotSimple<ArtifactSummaryParsed>(
    {
      host: config.host,
      model: config.model,
      system,
      user,
      schema: ArtifactSummaryJsonSchema,
      numCtx: config.numCtx,
      timeoutMs: 60000,
    },
    (value) => ArtifactSummarySchema.parse(value),
  );

  if (result.ok && result.data) {
    return {
      summary: result.data.summary,
      keyPoints: result.data.key_points,
    };
  }

  // ha az osszefoglalo hivas elbukik, keszitunk egy nagyon egyszerut kezzel.
  // fontos, hogy ilyenkor se szalljon el az egesz folyamat.
  const firstLines = body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(0, 3)
    .join(' ')
    .slice(0, 300);

  return {
    summary: firstLines || 'A tartalom összefoglalása nem sikerült.',
    keyPoints: [],
  };
}

// ----------------------------------------------------------------------------
// mentes
// ----------------------------------------------------------------------------

export async function storeArtifact(input: StoreArtifactInput): Promise<Artifact> {
  const db = getDb();
  const id = `art_${randomUUID().slice(0, 8)}`;
  const now = Date.now();

  const { summary, keyPoints } = await buildSummary(
    input.body,
    input.kind,
    input.title,
  );

  // a kulcspontokat is az osszefoglaloba fuzzuk, hogy egy mezoben legyen
  const fullSummary =
    keyPoints.length > 0
      ? `${summary}\nKulcspontok:\n${keyPoints.map((p) => `- ${p}`).join('\n')}`
      : summary;

  const bytes = Buffer.byteLength(input.body, 'utf-8');

  db.prepare(
    `INSERT INTO artifacts
       (id, kind, title, url, summary, body, created_at, conversation_id, bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.title,
    input.url,
    fullSummary,
    input.body,
    now,
    input.conversationId,
    bytes,
  );

  // index the body, so read_artifact(id, query) can return the relevant part
  enqueueArtifact(id, input.conversationId, input.body, input.kind === 'file' ? 'file' : 'web');

  return {
    id,
    kind: input.kind,
    title: input.title,
    url: input.url,
    summary: fullSummary,
    body: input.body,
    createdAt: now,
    conversationId: input.conversationId,
    bytes,
  };
}

export function getArtifact(id: string): Artifact | null {
  const db = getDb();

  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
    | ArtifactRow
    | undefined;

  return row ? toArtifact(row) : null;
}

export function listArtifacts(conversationId: string): Artifact[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT * FROM artifacts
       WHERE conversation_id = ?
       ORDER BY created_at DESC`,
    )
    .all(conversationId) as ArtifactRow[];

  return rows.map(toArtifact);
}

// ----------------------------------------------------------------------------
// offload dontes
// ----------------------------------------------------------------------------

export interface OffloadResult {
  /** amit a modell lat: vagy a teljes szoveg, vagy az osszefoglalo */
  forModel: string;
  /** ha offloadoltunk, itt az azonosito */
  artifactId?: string;
  offloaded: boolean;
}

/**
 * eldonti, hogy egy tool-kimenet mehet-e egyben a kontextusba,
 * vagy artifactba kell tenni.
 *
 * ha offloadolunk, a kontextusba egy rovid blokk kerul, ami tartalmazza:
 *   - mi ez es honnan jott
 *   - egy 2-3 mondatos osszefoglalot
 *   - a kulcspontokat
 *   - az azonositot, amivel visszakerheto
 */
export async function maybeOffload(
  input: StoreArtifactInput,
): Promise<OffloadResult> {
  const tokens = estimateTokens(input.body);

  if (tokens <= config.thresholdTokens) {
    return { forModel: input.body, offloaded: false };
  }

  const artifact = await storeArtifact(input);

  const header = artifact.title
    ? `[ARTIFACT ${artifact.id} — ${artifact.title}]`
    : `[ARTIFACT ${artifact.id}]`;

  const forModel = [
    header,
    artifact.summary,
    '',
    `A teljes tartalom lekérhető a \`read_artifact\` eszközzel (id: ${artifact.id}).`,
    `Ha csak egy részlet kell, add meg a query paramétert is.`,
  ].join('\n');

  return { forModel, artifactId: artifact.id, offloaded: true };
}

// ----------------------------------------------------------------------------
// visszaolvasas
// ----------------------------------------------------------------------------

/**
 * visszaadja egy artifact tartalmat.
 *
 * ha van query, akkor NEM a teljes szoveget adjuk vissza, hanem csak a
 * relevans reszt. ez fontos, kulonben a visszaolvasas ugyanugy megtoltene
 * a kontextust, mint az eredeti tartalom.
 */
export async function readArtifact(
  id: string,
  query?: string,
  maxTokens = 1500,
): Promise<{ ok: boolean; text: string; error?: string }> {
  const artifact = getArtifact(id);

  if (!artifact) {
    return {
      ok: false,
      text: '',
      error: `nincs ilyen artifact: ${id}`,
    };
  }

  const totalTokens = estimateTokens(artifact.body);

  // ha elfer egyben, adjuk vissza egyben
  if (totalTokens <= maxTokens) {
    return { ok: true, text: artifact.body };
  }

  // ha nincs query, az elejet adjuk vissza levagva
  if (!query || query.trim().length === 0) {
    const charsPerToken = artifact.body.length / totalTokens;
    const cutAt = Math.floor(maxTokens * charsPerToken);

    return {
      ok: true,
      text:
        artifact.body.slice(0, cutAt) +
        `\n\n[...a tartalom folytatódik. Adj meg egy query paramétert a releváns rész kereséséhez.]`,
    };
  }

  // query eseten a chunkokbol valogatunk.
  // a chunkokat az indexer teszi be, source_id = az artifact id-je.
  const { hybridSearch } = await import('./retrieval');

  const hits = await hybridSearch(query, {
    limit: 5,
    sourceTypes: ['web', 'file'],
  });

  const relevant = hits.filter((h) => h.sourceId === id);

  if (relevant.length === 0) {
    // nincs indexelve vagy nincs talalat -> egyszeru szoveges kereses
    return { ok: true, text: naiveExcerpt(artifact.body, query, maxTokens) };
  }

  const text = relevant.map((h) => h.text).join('\n\n---\n\n');

  return { ok: true, text };
}

/**
 * nagyon egyszeru kivonatolas: megkeresi a kereses szavait a szovegben,
 * es a korulottuk levo reszt adja vissza.
 *
 * ez a vegso mentoov, ha a retrieval nem mukodik.
 */
function naiveExcerpt(body: string, query: string, maxTokens: number): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);

  if (words.length === 0) return body.slice(0, maxTokens * 3);

  const lines = body.split('\n');
  const scored: { line: string; index: number; score: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;

    for (const word of words) {
      if (lower.includes(word)) score++;
    }

    if (score > 0) scored.push({ line: lines[i], index: i, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // a legjobb 5 talalat kore szedunk 2-2 sort
  const selected = new Set<number>();

  for (const item of scored.slice(0, 5)) {
    for (let i = Math.max(0, item.index - 2); i <= Math.min(lines.length - 1, item.index + 2); i++) {
      selected.add(i);
    }
  }

  const indices = [...selected].sort((a, b) => a - b);
  const parts: string[] = [];
  let previous = -2;

  for (const index of indices) {
    if (index > previous + 1) parts.push('[...]');
    parts.push(lines[index]);
    previous = index;
  }

  const result = parts.join('\n');
  return estimateTokens(result) > maxTokens
    ? result.slice(0, maxTokens * 3)
    : result;
}
