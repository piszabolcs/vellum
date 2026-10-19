// ============================================================================
// Demo profile: fills a SEPARATE profile folder with English sample data
// (conversations with sources and tool calls, typed memory with suggestions,
// a small notes folder) for screenshots and demos. It never touches the real
// %APPDATA%\Vellum.
//
//   npm run seed:demo -- <profile-dir>
//   set VELLUM_PROFILE_DIR=<profile-dir> && npm start
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

import { closeDatabase, initDatabase } from '../electron/db';
import {
  appendMessage,
  archiveConversation,
  createConversation,
  renameConversation,
} from '../electron/conversations';
import { addCandidates, initMemory, upsertEntry } from '../electron/memory';
import { writeJsonAtomicSync } from '../electron/jsonStore';
import { DEFAULT_SETTINGS, FILES } from '../electron/shared';

const profileRoot = process.argv[2];
if (!profileRoot) {
  console.error('usage: npm run seed:demo -- <profile-dir>');
  process.exit(1);
}

const dataDir = path.join(path.resolve(profileRoot), 'Vellum');
if (fs.existsSync(path.join(dataDir, FILES.database))) {
  console.error(`${dataDir} already has a database; pick an empty folder.`);
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });

// --- a small notes folder for the read-only file tool ---
const notesDir = path.join(path.resolve(profileRoot), 'demo-notes');
fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(
  path.join(notesDir, 'sales.csv'),
  'week,region,orders,revenue\n38,North,124,18450\n38,South,98,14210\n39,North,131,19980\n39,South,105,15020\n',
);
fs.writeFileSync(
  path.join(notesDir, 'homelab.md'),
  '# Home lab\n\n- NAS: backups every night at 02:00\n- Docker host: 16 GB RAM, compose files in /srv/stacks\n',
);

writeJsonAtomicSync(path.join(dataDir, FILES.settings), {
  ...DEFAULT_SETTINGS,
  language: 'en',
  ollamaModel: 'qwen3:8b',
  globalHotkey: '',
  filesRootPath: notesDir,
});
// no Haverom data to migrate in a demo profile
fs.writeFileSync(path.join(dataDir, FILES.migrationMarker), JSON.stringify({ from: 'none', at: Date.now() }));

const db = initDatabase({ dbPath: path.join(dataDir, FILES.database), embeddingDim: 1024, embeddingModel: 'bge-m3' });
if (!db.ok) {
  console.error('could not open the database:', db.error);
  process.exit(1);
}

function conversation(
  title: string,
  turns: { role: 'user' | 'assistant'; content: string; meta?: Parameters<typeof appendMessage>[0]['meta'] }[],
): string {
  const created = createConversation('qwen3:8b');
  for (const turn of turns) appendMessage({ conversationId: created.id, ...turn });
  renameConversation(created.id, title);
  return created.id;
}

const stats = (promptTokens: number, responseTokens: number, tokensPerSecond: number) => ({
  promptTokens,
  responseTokens,
  tokensPerSecond,
});

const archived = conversation('Packing list for a weekend hike', [
  { role: 'user', content: 'Make me a short packing list for a two-day hike in October.' },
  {
    role: 'assistant',
    content:
      '- Layers: base layer, fleece, rain shell\n- Head torch + spare batteries\n- 2 l water, snacks, a hot drink\n- Map offline on the phone **and** on paper\n- First-aid kit, emergency blanket',
    meta: { stats: stats(640, 88, 41.2) },
  },
]);
archiveConversation(archived, true);

conversation('Convert 5 km to miles', [
  { role: 'user', content: 'How many miles is a 5 km run?' },
  {
    role: 'assistant',
    content: 'A 5 km run is **3.11 miles** (5 km × 0.621371).',
    meta: {
      toolCalls: [{ name: 'calculate', args: { expression: '5 km to mi' }, ok: true, durationMs: 4 }],
      stats: stats(702, 31, 44.8),
    },
  },
]);

conversation('Weekly orders from sales.csv', [
  { role: 'user', content: 'Summarize sales.csv by week, totals only.' },
  {
    role: 'assistant',
    content:
      '| Week | Orders | Revenue |\n|---|---:|---:|\n| 38 | 222 | 32 660 |\n| 39 | 236 | 35 000 |\n\nWeek 39 is up **6.3 %** in orders and **7.2 %** in revenue.',
    meta: {
      toolCalls: [{ name: 'read_file', args: { path: 'sales.csv' }, ok: true, durationMs: 12 }],
      stats: stats(1184, 97, 39.5),
    },
  },
]);

conversation('Docker bridge vs host networking', [
  { role: 'user', content: 'When should I use host networking instead of the default bridge in Docker?' },
  {
    role: 'assistant',
    content: [
      'Use the **default bridge** (or a user-defined bridge) unless you have a concrete reason not to: each container gets its own network namespace, ports are published explicitly, and containers on a user-defined bridge can reach each other by name [F1].',
      '',
      'Pick **host networking** when the extra NAT hop matters or the service needs the host interfaces directly - e.g. many ports, multicast/discovery, or latency-sensitive traffic. The trade-off: no port mapping and no isolation from the host network [F2].',
      '',
      '| | bridge | host |',
      '|---|---|---|',
      '| Isolation | own namespace | shares the host stack |',
      '| Ports | `-p 8080:80` | binds directly |',
      '| Typical use | most services | discovery, high-throughput |',
      '',
      'Sources: [F1] Docker docs - Bridge network driver, [F2] Docker docs - Host network driver',
    ].join('\n'),
    meta: {
      sources: [
        { id: 'F1', url: 'https://docs.docker.com/engine/network/drivers/bridge/', title: 'Bridge network driver' },
        { id: 'F2', url: 'https://docs.docker.com/engine/network/drivers/host/', title: 'Host network driver' },
      ],
      toolCalls: [
        { name: 'web_search', args: { query: 'docker host vs bridge network' }, ok: true, durationMs: 4810 },
      ],
      stats: stats(2310, 214, 38.6),
    },
  },
]);

closeDatabase();

// --- typed memory: all five types, plus two suggestions waiting for approval ---
initMemory(dataDir);
const entries: Parameters<typeof upsertEntry>[0][] = [
  { type: 'fact', content: 'Works on Windows 11 with VS Code and PowerShell.', priority: 3 },
  { type: 'fact', content: 'Has an NVIDIA GPU with 8 GB of VRAM.', priority: 2 },
  { type: 'person', content: 'Dana is the team lead and prefers short status updates.', priority: 3 },
  { type: 'project', content: 'Moving the home-lab services to Docker Compose.', priority: 4 },
  { type: 'preference', content: 'Prefers metric units.', priority: 3 },
  { type: 'style', content: 'Answer in short paragraphs; put code in fenced blocks.', priority: 5 },
];

(async () => {
  for (const entry of entries) await upsertEntry(entry);
  await addCandidates(
    [
      { type: 'fact', content: 'Is learning Rust in the evenings.', confidence: 0.8 },
      { type: 'preference', content: 'Likes dark editor themes.', confidence: 0.6 },
    ],
    null,
  );
  console.log(`Demo profile ready: ${dataDir}`);
})();
