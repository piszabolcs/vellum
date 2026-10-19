import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listDirectory, readFileSafe } from './files';

// The assessment's sandbox probes, kept as regression tests.
let base = '';
let root = '';
let outside = '';
let junction = false;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'vellum-files-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello from root');
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), '# b');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE SECRET');
  for (const name of ['secrets.env', '.env', 'id_rsa', 'server.pem']) {
    fs.writeFileSync(path.join(root, name), 'dummy-not-a-real-secret');
  }
  fs.writeFileSync(path.join(root, 'bin.txt'), Buffer.from([0x41, 0x00, 0x42]));
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(6 * 1024 * 1024, 0x41));
  try {
    fs.symlinkSync(outside, path.join(root, 'jlink'), 'junction');
    junction = true;
  } catch {
    junction = false;
  }
});

afterAll(() => {
  if (junction) fs.rmSync(path.join(root, 'jlink'), { force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

describe('file tool sandbox', () => {
  it('reads text files inside the chosen folder', async () => {
    for (const p of ['a.txt', 'sub/b.md', 'sub\\..\\a.txt']) {
      const result = await readFileSafe(p, root);
      expect(result.ok, p).toBe(true);
    }
  });

  it('refuses every path that leaves the folder', async () => {
    const escapes = [
      '../outside/secret.txt',
      path.join(outside, 'secret.txt'),
      '\\\\?\\' + path.join(outside, 'secret.txt'),
      'C:\\Windows\\win.ini',
      'a.txt\0.md',
      ...(junction ? ['jlink/secret.txt'] : []),
    ];
    for (const p of escapes) {
      const result = await readFileSafe(p, root);
      expect(result.ok, p).toBe(false);
    }
    if (junction) expect((await listDirectory('jlink', root)).ok).toBe(false);
  });

  it('never hands secret-looking, binary or oversized files to the model', async () => {
    for (const p of ['secrets.env', '.env', 'id_rsa', 'server.pem', 'bin.txt', 'big.txt']) {
      const result = await readFileSafe(p, root);
      expect(result.ok, p).toBe(false);
    }
  });
});
