import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initMemory, loadMemory, takeMemoryLoadIssue, upsertEntry } from './memory';

let dir = '';
const memoryFile = () => path.join(dir, 'memory.json');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vellum-memory-'));
  initMemory(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory.json handling', () => {
  it('moves a corrupt file aside and reports it instead of overwriting it', async () => {
    fs.writeFileSync(memoryFile(), '{"entries": [ {"type": "fact", "content": "half-writ');

    const loadedCount = (await loadMemory()).entries.length;
    const issue = takeMemoryLoadIssue();
    await upsertEntry({ type: 'fact', content: 'new entry after the crash' });

    expect(loadedCount).toBe(0);
    expect(issue?.backupPath).toMatch(/memory\.json\.corrupt-/);
    expect(fs.readFileSync(issue!.backupPath!, 'utf-8')).toContain('half-writ');
  });

  it('writes atomically and keeps the previous version as .bak', async () => {
    await upsertEntry({ type: 'fact', content: 'first entry' });
    await upsertEntry({ type: 'fact', content: 'second entry' });

    const current = JSON.parse(fs.readFileSync(memoryFile(), 'utf-8'));
    const backup = JSON.parse(fs.readFileSync(`${memoryFile()}.bak`, 'utf-8'));

    expect(current.entries).toHaveLength(2);
    expect(backup.entries).toHaveLength(1);
    expect(fs.existsSync(`${memoryFile()}.tmp`)).toBe(false);
  });
});
