// ============================================================================
// Smoke test: conversation handling against a REAL SQLite database.
// ============================================================================
// better-sqlite3 is built for the Electron ABI, so it cannot be loaded under
// vitest (plain Node) -- the database side of the archive is covered here, under
// Electron:
//
//   npm run smoke:conversations
//
// Works in a throw-away database in the temp folder; the real vellum.db is
// never touched.
// ============================================================================

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initDatabase, closeDatabase } from '../electron/db';
import {
  appendMessage,
  createConversation,
  forkConversation,
  getMessages,
  listConversations,
  renameConversation,
  searchMessages,
} from '../electron/conversations';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  OK    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function run(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vellum-smoke-'));
  const dbPath = path.join(dir, 'smoke.db');

  console.log(`\nDatabase: ${dbPath}\n`);

  const opened = initDatabase({
    dbPath,
    embeddingDim: 1024,
    embeddingModel: 'bge-m3',
  });

  check('database opened', opened.ok, opened.ok ? '' : String(opened.error));
  if (!opened.ok) return;
  check('sqlite-vec extension loaded (vector search)', opened.vectorSearchAvailable);

  // --- the first conversation after start-up: its id comes from the renderer
  //     and was never inserted (this used to fail on the foreign key) ---
  appendMessage({ conversationId: 'conv-renderer-1', role: 'user', content: 'First question after start-up' });
  appendMessage({ conversationId: 'conv-renderer-1', role: 'assistant', content: 'First answer' });
  const first = listConversations().find((c) => c.id === 'conv-renderer-1');
  check('a message to a new conversation id creates the conversation', first !== undefined);
  check('the first conversation keeps both messages', first?.messageCount === 2, `got: ${first?.messageCount}`);

  // --- basic conversation ---
  const source = createConversation('qwen3:8b');
  const m1 = appendMessage({ conversationId: source.id, role: 'user', content: 'First question' });
  const m2 = appendMessage({
    conversationId: source.id,
    role: 'assistant',
    content: 'First answer about Docker networking',
  });
  const m3 = appendMessage({ conversationId: source.id, role: 'user', content: 'Second question' });
  appendMessage({ conversationId: source.id, role: 'assistant', content: 'Second answer' });

  check('4 messages stored', getMessages(source.id).length === 4);

  // --- fork up to the second message ---
  const branch = forkConversation(source.id, m2.id);
  check('the fork was created', branch !== null);

  if (branch) {
    const copied = getMessages(branch.id);
    check('the fork copied 2 messages', copied.length === 2, `got: ${copied.length}`);
    check('the content matches', copied[1]?.content === m2.content);
    check('new message ids were created', copied[0]?.id !== m1.id);
    check('the counter is correct', branch.messageCount === 2);

    // the original is untouched
    check('the original is untouched', getMessages(source.id).length === 4);

    // the fork lives on as its own thread
    appendMessage({ conversationId: branch.id, role: 'user', content: 'Question after the fork' });
    check('the fork grows on its own', getMessages(branch.id).length === 3);
    check('the original still does not change', getMessages(source.id).length === 4);
  }

  // --- full fork (no message id) ---
  const full = forkConversation(source.id);
  check('a full fork copies the whole history', full !== null && getMessages(full.id).length === 4);

  // --- unknown message id ---
  check('no fork for an unknown message id', forkConversation(source.id, 'no-such-id') === null);

  // --- title inheritance ---
  renameConversation(source.id, 'Docker networking');
  const titled = forkConversation(source.id, m3.id);
  check(
    'the fork title marks the branch',
    titled?.title === 'Docker networking (elágazás)' || titled?.title === 'Docker networking (branch)',
    titled?.title,
  );

  // --- search ---
  const hits = searchMessages('docker');
  check('keyword search finds it', hits.length > 0, `${hits.length} hits`);

  // --- list ---
  check('the list sees every conversation', listConversations().length >= 5);

  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
}

app.whenReady().then(() => {
  try {
    run();
  } catch (error) {
    failures += 1;
    console.log(`\nUNEXPECTED ERROR: ${error instanceof Error ? error.stack : String(error)}`);
  }

  console.log(failures === 0 ? '\nALL GOOD\n' : `\n${failures} FAILED\n`);
  app.exit(failures === 0 ? 0 : 1);
});
