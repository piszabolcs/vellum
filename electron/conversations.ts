// ============================================================================
// vellum - conversations.ts (F4)
// ============================================================================
// beszelgetesek es uzenetek perzisztalasa sqlite-ban.
//
// a haveromban egyetlen beszelgetes letezett, localStorage-ban, es az
// "uj beszelgetes" gomb eldobta az elozot. itt minden megmarad, kereshetoen.
// ============================================================================

import { randomUUID } from 'node:crypto';

import type { Conversation, StoredMessage, MessageMeta, MessageRole } from './shared';
import { getDb } from './db';
import { estimateTokens } from './tokenizer';
import { tr } from './i18n';

// ----------------------------------------------------------------------------
// sor -> objektum atalakitas
// ----------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  message_count: number;
  archived: number;
  summary: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  content: string;
  thinking: string | null;
  created_at: number;
  token_count: number | null;
  is_error: number;
  meta_json: string | null;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    messageCount: row.message_count,
    archived: row.archived === 1,
    summary: row.summary,
  };
}

function toMessage(row: MessageRow): StoredMessage {
  let meta: MessageMeta | null = null;

  if (row.meta_json) {
    try {
      meta = JSON.parse(row.meta_json) as MessageMeta;
    } catch {
      meta = null;
    }
  }

  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role as MessageRole,
    content: row.content,
    thinking: row.thinking,
    createdAt: row.created_at,
    tokenCount: row.token_count,
    isError: row.is_error === 1,
    meta,
  };
}

// ----------------------------------------------------------------------------
// beszelgetesek
// ----------------------------------------------------------------------------

export function createConversation(model: string | null = null): Conversation {
  const db = getDb();
  const now = Date.now();
  const id = `conv_${randomUUID()}`;

  db.prepare(
    `INSERT INTO conversations
       (id, title, created_at, updated_at, model, message_count, archived, summary)
     VALUES (?, '', ?, ?, ?, 0, 0, NULL)`,
  ).run(id, now, now, model);

  return {
    id,
    title: '',
    createdAt: now,
    updatedAt: now,
    model,
    messageCount: 0,
    archived: false,
    summary: null,
  };
}

export function getConversation(id: string): Conversation | null {
  const db = getDb();

  const row = db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(id) as ConversationRow | undefined;

  return row ? toConversation(row) : null;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export function listConversations(options?: ListOptions): Conversation[] {
  const db = getDb();
  const limit = options?.limit ?? 100;
  const offset = options?.offset ?? 0;

  const where = options?.includeArchived ? '' : 'WHERE archived = 0';

  const rows = db
    .prepare(
      `SELECT * FROM conversations
       ${where}
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ConversationRow[];

  return rows.map(toConversation);
}

export function renameConversation(id: string, title: string): boolean {
  const db = getDb();

  const result = db
    .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 120), Date.now(), id);

  return result.changes > 0;
}

export function archiveConversation(id: string, archived: boolean): boolean {
  const db = getDb();

  const result = db
    .prepare('UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 1 : 0, Date.now(), id);

  return result.changes > 0;
}

/**
 * torol egy beszelgetest az uzeneteivel es chunkjaival egyutt.
 * az uzeneteket a foreign key cascade torli, a chunkokat kezzel kell.
 */
export function deleteConversation(id: string): boolean {
  const db = getDb();

  // eloszor a chunkok, mert azokra nincs cascade
  const chunkIds = db
    .prepare('SELECT id FROM chunks WHERE conversation_id = ?')
    .all(id) as { id: number }[];

  if (chunkIds.length > 0) {
    const placeholders = chunkIds.map(() => '?').join(', ');

    try {
      db.prepare(
        `DELETE FROM chunks_vec WHERE chunk_id IN (${placeholders})`,
      ).run(...chunkIds.map((r) => r.id));
    } catch {
      // ha nincs vektortabla, nincs mit torolni
    }

    db.prepare('DELETE FROM chunks WHERE conversation_id = ?').run(id);
  }

  db.prepare('DELETE FROM artifacts WHERE conversation_id = ?').run(id);

  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

  return result.changes > 0;
}

/**
 * elagaztat egy beszelgetest: az uzeneteket a megadott pontig atmasolja
 * egy uj beszelgetesbe.
 *
 * `uptoMessageId` nelkul a teljes elozmenyt viszi. A megadott uzenet MEG
 * bekerul a masolatba -- "innen agazz el" azt jelenti, hogy ezt a valaszt
 * meg latni akarom az uj szalban.
 *
 * FONTOS: a masolt uzeneteket NEM adjuk at az indexelonek. Ugyanaz a szoveg
 * mar bent van a vektorindexben az eredeti szalbol; ha ujraindexelnenk, a
 * szemantikus kereses ugyanazt a tartalmat tobbszor adna vissza. Az uj szal
 * sajat, ezutan irt uzenetei a szokasos uton indexelodnek.
 */
export function sliceUpToMessage<T extends { id: string }>(
  messages: T[],
  uptoMessageId?: string,
): T[] | null {
  if (!uptoMessageId) return messages;

  const cut = messages.findIndex((m) => m.id === uptoMessageId);

  // ismeretlen uzenet-id eseten inkabb nem talalgatunk: a hivo dontse el,
  // mit kezd vele. csendben a teljes elozmenyt masolni rosszabb lenne, mint
  // nem csinalni semmit.
  if (cut === -1) return null;

  return messages.slice(0, cut + 1);
}

export function forkConversation(
  sourceId: string,
  uptoMessageId?: string,
): Conversation | null {
  const db = getDb();
  const source = getConversation(sourceId);

  if (!source) return null;

  const slice = sliceUpToMessage(getMessages(sourceId), uptoMessageId);

  if (!slice) return null;

  const now = Date.now();
  const newId = `conv_${randomUUID()}`;
  // ures cim eseten hagyjuk uresen, hogy a cimgeneralas lefusson ra
  const title = source.title ? `${source.title}${tr('conv.forkSuffix')}`.slice(0, 120) : '';

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO conversations
         (id, title, created_at, updated_at, model, message_count, archived, summary)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(newId, title, now, now, source.model, slice.length, source.summary);

    const insert = db.prepare(
      `INSERT INTO messages
         (id, conversation_id, seq, role, content, thinking,
          created_at, token_count, is_error, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    slice.forEach((message, seq) => {
      insert.run(
        `msg_${randomUUID()}`,
        newId,
        seq,
        message.role,
        message.content,
        message.thinking,
        message.createdAt,
        message.tokenCount,
        message.isError ? 1 : 0,
        message.meta ? JSON.stringify(message.meta) : null,
      );
    });
  });

  run();

  return {
    id: newId,
    title,
    createdAt: now,
    updatedAt: now,
    model: source.model,
    messageCount: slice.length,
    archived: false,
    summary: source.summary,
  };
}

export function setSummary(id: string, summary: string): void {
  const db = getDb();

  db.prepare('UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?').run(
    summary,
    Date.now(),
    id,
  );
}

// ----------------------------------------------------------------------------
// uzenetek
// ----------------------------------------------------------------------------

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  thinking?: string | null;
  isError?: boolean;
  meta?: MessageMeta | null;
}

export function appendMessage(input: AppendMessageInput): StoredMessage {
  const db = getDb();
  const now = Date.now();
  const id = `msg_${randomUUID()}`;
  const tokenCount = estimateTokens(input.content);
  let seq = 0;

  db.transaction(() => {
    // The first conversation after start-up has an id generated by the renderer
    // that was never inserted; without this row the message insert failed on the
    // foreign key and the first conversation never reached the archive.
    db.prepare(
      `INSERT OR IGNORE INTO conversations
         (id, title, created_at, updated_at, model, message_count, archived, summary)
       VALUES (?, '', ?, ?, NULL, 0, 0, NULL)`,
    ).run(input.conversationId, now, now);

    // a kovetkezo sorszam a beszelgetesen belul
    const seqRow = db
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE conversation_id = ?')
      .get(input.conversationId) as { next: number } | undefined;

    seq = seqRow?.next ?? 0;

    db.prepare(
      `INSERT INTO messages
         (id, conversation_id, seq, role, content, thinking,
          created_at, token_count, is_error, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.conversationId,
      seq,
      input.role,
      input.content,
      input.thinking ?? null,
      now,
      tokenCount,
      input.isError ? 1 : 0,
      input.meta ? JSON.stringify(input.meta) : null,
    );

    // a beszelgetes szamlaloja es idobelyege frissul
    db.prepare(
      `UPDATE conversations
       SET message_count = message_count + 1, updated_at = ?
       WHERE id = ?`,
    ).run(now, input.conversationId);
  })();

  return {
    id,
    conversationId: input.conversationId,
    seq,
    role: input.role,
    content: input.content,
    thinking: input.thinking ?? null,
    createdAt: now,
    tokenCount,
    isError: input.isError ?? false,
    meta: input.meta ?? null,
  };
}

export function updateMessage(
  id: string,
  updates: {
    content?: string;
    thinking?: string | null;
    meta?: MessageMeta | null;
    isError?: boolean;
  },
): boolean {
  const db = getDb();

  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.content !== undefined) {
    sets.push('content = ?', 'token_count = ?');
    params.push(updates.content, estimateTokens(updates.content));
  }

  if (updates.thinking !== undefined) {
    sets.push('thinking = ?');
    params.push(updates.thinking);
  }

  if (updates.meta !== undefined) {
    sets.push('meta_json = ?');
    params.push(updates.meta ? JSON.stringify(updates.meta) : null);
  }

  if (updates.isError !== undefined) {
    sets.push('is_error = ?');
    params.push(updates.isError ? 1 : 0);
  }

  if (sets.length === 0) return false;

  params.push(id);

  const result = db
    .prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);

  return result.changes > 0;
}

export function getMessages(conversationId: string): StoredMessage[] {
  const db = getDb();

  const rows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq ASC')
    .all(conversationId) as MessageRow[];

  return rows.map(toMessage);
}

/**
 * a modellnek kuldheto uzenetlista.
 *
 * KRITIKUS: a hibabuborekokat kiszurjuk. ez a haverombol orokolt viselkedes,
 * es fontos: kulonben a modell a sajat hibauzenetere reagalna, ami
 * egyre zavarosabb valaszokhoz vezet.
 */
export function getMessagesForModel(
  conversationId: string,
  options?: { skipBeforeSeq?: number },
): StoredMessage[] {
  const all = getMessages(conversationId);

  return all.filter((m) => {
    if (m.isError) return false;
    if (m.role === 'system') return false; // a system reteget a provider epiti
    if (options?.skipBeforeSeq !== undefined && m.seq < options.skipBeforeSeq) {
      return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------------
// kereses a beszelgetesekben
// ----------------------------------------------------------------------------

export interface ConversationSearchResult {
  conversation: Conversation;
  /** a talalat kornyeke, kiemelesre */
  snippet: string;
  messageId: string;
  createdAt: number;
}

/**
 * gyors kulcsszavas kereses az uzenetek kozott (fts5).
 * gepeles kozbeni keresesre valo. a szemantikus keresest a retrieval.ts adja.
 */
export function searchMessages(
  query: string,
  limit = 20,
): ConversationSearchResult[] {
  const db = getDb();

  const words = query
    .toLowerCase()
    .replace(/["'*^:(){}[\]-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (words.length === 0) return [];

  const ftsQuery = words.map((w) => `"${w}"*`).join(' OR ');

  try {
    const rows = db
      .prepare(
        `SELECT m.id AS message_id, m.conversation_id, m.created_at,
                snippet(messages_fts, 0, '<<', '>>', '...', 24) AS snippet,
                c.id, c.title, c.created_at AS c_created, c.updated_at,
                c.model, c.message_count, c.archived, c.summary
         FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         JOIN conversations c ON c.id = m.conversation_id
         WHERE messages_fts MATCH ?
         ORDER BY bm25(messages_fts)
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as {
      message_id: string;
      conversation_id: string;
      created_at: number;
      snippet: string;
      id: string;
      title: string;
      c_created: number;
      updated_at: number;
      model: string | null;
      message_count: number;
      archived: number;
      summary: string | null;
    }[];

    return rows.map((row) => ({
      conversation: {
        id: row.id,
        title: row.title,
        createdAt: row.c_created,
        updatedAt: row.updated_at,
        model: row.model,
        messageCount: row.message_count,
        archived: row.archived === 1,
        summary: row.summary,
      },
      snippet: row.snippet,
      messageId: row.message_id,
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// export
// ----------------------------------------------------------------------------

/** markdown formatumba exportal egy beszelgetest */
export function exportConversationMarkdown(id: string): string | null {
  const conversation = getConversation(id);
  if (!conversation) return null;

  const messages = getMessages(id);
  const lines: string[] = [];

  const title = conversation.title || tr('conv.untitled');
  const date = new Date(conversation.createdAt).toISOString().slice(0, 16).replace('T', ' ');

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`*${tr('conv.created', { date })}*`);
  if (conversation.model) lines.push(`*${tr('conv.model', { model: conversation.model })}*`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    if (message.role === 'system') continue;

    const who =
      message.role === 'user'
        ? `**${tr('conv.me')}:**`
        : message.role === 'assistant'
          ? '**Vellum:**'
          : `**${message.role}:**`;

    lines.push(who);
    lines.push('');
    lines.push(message.content);
    lines.push('');

    if (message.meta?.sources && message.meta.sources.length > 0) {
      lines.push(tr('conv.sources'));
      for (const source of message.meta.sources) {
        lines.push(`- [${source.id}] ${source.title} — ${source.url}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
