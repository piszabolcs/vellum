// ============================================================================
// vellum - db.ts (F4)
// ============================================================================
// sqlite adatbazis a beszelgetesekhez, chunkokhoz es vektorokhoz.
//
// miert sqlite es nem kulon vektoradatbazis (qdrant, chroma, weaviate):
// tizezres nagysagrendu embedding elfer egyetlen gepen extra infrastruktura
// nelkul. egy fajl, nulla szolgaltatas, nulla port, nulla docker.
//
// miert better-sqlite3: szinkron api, ami az electron main processben
// egyszerubb es gyorsabb, mint az aszinkron. cserebe nativ modul, tehat
// electron-rebuild kell hozza (windowson vs build tools is).
//
// a vektorkereseshez a sqlite-vec bovitmenyt hasznaljuk: nativ vektortipust
// es knn-keresest hoz be magaba az adatbazisba.
// ============================================================================

import path from 'node:path';
import fs from 'node:fs';

// a tipusokat lazan kezeljuk, hogy ne kelljen a @types/better-sqlite3
// fuggosegtol fuggeni a fordulashoz
type SqliteStatement = {
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => void;
  pragma: (sql: string) => unknown;
  close: () => void;
  transaction: <T extends (...args: never[]) => unknown>(fn: T) => T;
};

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

let db: SqliteDatabase | null = null;
let vecAvailable = false;
let currentEmbeddingDim = 0;

/** a jelenlegi sema verzio. ha valtozik, migracio kell. */
const SCHEMA_VERSION = 1;

// ----------------------------------------------------------------------------
// inicializalas
// ----------------------------------------------------------------------------

export interface DbInitOptions {
  /** az adatbazis fajl teljes utvonala */
  dbPath: string;
  /** az embedding vektorok dimenzioja. bge-m3 = 1024, nomic = 768 */
  embeddingDim: number;
  /** az embedding modell neve, hogy tudjuk, mikor kell ujraindexelni */
  embeddingModel: string;
}

export interface DbInitResult {
  ok: boolean;
  vectorSearchAvailable: boolean;
  /** ha az embedding modell valtozott, ujra kell indexelni mindent */
  needsReindex: boolean;
  error?: string;
}

/**
 * megnyitja (vagy letrehozza) az adatbazist, es lefuttatja a migraciokat.
 *
 * ha a sqlite-vec nem toltheto be, az app tovabb mukodik, csak a
 * szemantikus kereses lesz kikapcsolva -- az fts5 kulcsszavas kereses
 * viszont akkor is el. ez fontos: egy hianyzo bovitmeny ne vigye el az appot.
 */
export function initDatabase(options: DbInitOptions): DbInitResult {
  try {
    // dinamikus require, hogy a modul betoltese ne omoljon ossze,
    // ha valamiert nincs meg a nativ binaris
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (
      path: string,
    ) => SqliteDatabase;

    const dir = path.dirname(options.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    db = new Database(options.dbPath);

    // a wal mod gyorsabb irast ad, es nem zarja ki az olvasokat
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // sqlite-vec betoltese
    vecAvailable = tryLoadSqliteVec(db);
    currentEmbeddingDim = options.embeddingDim;

    // sema letrehozasa
    createBaseSchema(db);

    if (vecAvailable) {
      createVectorSchema(db, options.embeddingDim);
    }

    // megnezzuk, valtozott-e az embedding modell
    const needsReindex = checkEmbeddingModelChange(
      options.embeddingModel,
      options.embeddingDim,
    );

    return { ok: true, vectorSearchAvailable: vecAvailable, needsReindex };
  } catch (error) {
    return {
      ok: false,
      vectorSearchAvailable: false,
      needsReindex: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function tryLoadSqliteVec(database: SqliteDatabase): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require('sqlite-vec') as {
      load: (db: unknown) => void;
    };

    sqliteVec.load(database);

    // ellenorizzuk, hogy tenyleg mukodik-e
    const row = database.prepare('SELECT vec_version() AS version').get() as
      | { version: string }
      | undefined;

    return typeof row?.version === 'string';
  } catch {
    // nincs sqlite-vec -> csak fts5 kereses lesz
    return false;
  }
}

// ----------------------------------------------------------------------------
// sema
// ----------------------------------------------------------------------------

function createBaseSchema(database: SqliteDatabase): void {
  database.exec(`
    -- ============ meta ============
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ============ beszelgetesek ============
    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL DEFAULT '',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      model         TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      archived      INTEGER NOT NULL DEFAULT 0,
      summary       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conv_updated
      ON conversations(updated_at DESC);

    -- ============ uzenetek ============
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      thinking        TEXT,
      created_at      INTEGER NOT NULL,
      token_count     INTEGER,
      is_error        INTEGER NOT NULL DEFAULT 0,
      meta_json       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv
      ON messages(conversation_id, seq);

    -- ============ teljes szoveges kereses ============
    -- a remove_diacritics 2 fontos: igy a "gyartosor" is megtalalja a
    -- "gyártósor"-t, ami magyar szovegnel napi szintu igeny
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- triggerek, hogy az fts index szinkronban maradjon
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    -- ============ chunkok ============
    CREATE TABLE IF NOT EXISTS chunks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type     TEXT NOT NULL,
      source_id       TEXT NOT NULL,
      conversation_id TEXT,
      ord             INTEGER NOT NULL DEFAULT 0,
      text            TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      embedding_model TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_source
      ON chunks(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_conv
      ON chunks(conversation_id);

    -- a chunkokhoz is kell kulcsszavas kereses, a hibrid retrievalhez
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content='chunks',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_fts_insert
    AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_fts_delete
    AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES('delete', old.id, old.text);
    END;

    -- ============ artifactok ============
    CREATE TABLE IF NOT EXISTS artifacts (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      title           TEXT,
      url             TEXT,
      summary         TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      conversation_id TEXT,
      bytes           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_conv
      ON artifacts(conversation_id, created_at);

    -- ============ router naplo ============
    -- ez vedi a "csendes minosegromlas" ellen: ha a router rosszul
    -- osztalyoz, utolag visszakereshetonek kell lennie
    CREATE TABLE IF NOT EXISTS router_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      message_id      TEXT,
      decision_json   TEXT NOT NULL,
      duration_ms     INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_router_created
      ON router_log(created_at DESC);
  `);

  setMeta('schema_version', String(SCHEMA_VERSION));
}

function createVectorSchema(database: SqliteDatabase, dim: number): void {
  // FIGYELEM: a vec0 tabla dimenzioja FIX. ha embedding modellt valtunk,
  // a tablat el kell dobni es mindent ujra kell indexelni.
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `);
}

/**
 * megnezi, valtozott-e az embedding modell vagy a dimenzio.
 * ha igen, jelzi, hogy ujraindexeles kell.
 */
// A db peldanyt nem veszi at: a getMeta/setMeta amugy is a modulszintu
// kapcsolaton dolgozik, ket forrasbol olvasni csak felreertesre adna okot.
function checkEmbeddingModelChange(model: string, dim: number): boolean {
  const storedModel = getMeta('embedding_model');
  const storedDim = getMeta('embedding_dim');

  // elso indulas
  if (storedModel === null) {
    setMeta('embedding_model', model);
    setMeta('embedding_dim', String(dim));
    setMeta('created_at', String(Date.now()));
    return false;
  }

  const changed = storedModel !== model || storedDim !== String(dim);

  if (changed) {
    // nem irjuk felul azonnal: elobb a felhasznalonak jova kell hagynia
    // az ujraindexelest (lasd rebuildVectorIndex)
    return true;
  }

  return false;
}

// ----------------------------------------------------------------------------
// meta tabla
// ----------------------------------------------------------------------------

export function getMeta(key: string): string | null {
  if (!db) return null;

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;

  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  if (!db) return;

  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ----------------------------------------------------------------------------
// vektor index ujraepitese
// ----------------------------------------------------------------------------

/**
 * eldobja es ujra letrehozza a vektortablat az uj dimenzioval.
 * a chunkok is torlodnek, mert ujra kell oket embeddelni.
 *
 * ezt CSAK a felhasznalo kifejezett jovahagyasa utan szabad hivni,
 * mert percekig tarthat.
 */
export function rebuildVectorIndex(embeddingModel: string, dim: number): void {
  if (!db) return;

  if (vecAvailable) {
    db.exec('DROP TABLE IF EXISTS chunks_vec;');
    createVectorSchema(db, dim);
  }

  db.exec('DELETE FROM chunks;');
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');");

  setMeta('embedding_model', embeddingModel);
  setMeta('embedding_dim', String(dim));

  currentEmbeddingDim = dim;
}

// ----------------------------------------------------------------------------
// hozzaferes
// ----------------------------------------------------------------------------

export function getDb(): SqliteDatabase {
  if (!db) {
    throw new Error(
      'az adatbazis nincs inicializalva. hivd meg az initDatabase-t az app indulasakor.',
    );
  }
  return db;
}

export function isVectorSearchAvailable(): boolean {
  return vecAvailable;
}

export function getEmbeddingDim(): number {
  return currentEmbeddingDim;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ----------------------------------------------------------------------------
// statisztika
// ----------------------------------------------------------------------------

export interface DbStats {
  conversations: number;
  messages: number;
  chunks: number;
  artifacts: number;
  vectorSearchAvailable: boolean;
  embeddingModel: string | null;
  fileSizeBytes: number;
}

export function getStats(dbPath: string): DbStats {
  const database = getDb();

  const count = (table: string): number => {
    const row = database.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  };

  let fileSizeBytes = 0;
  try {
    fileSizeBytes = fs.statSync(dbPath).size;
  } catch {
    fileSizeBytes = 0;
  }

  return {
    conversations: count('conversations'),
    messages: count('messages'),
    chunks: count('chunks'),
    artifacts: count('artifacts'),
    vectorSearchAvailable: vecAvailable,
    embeddingModel: getMeta('embedding_model'),
    fileSizeBytes,
  };
}
