// ============================================================================
// vellum - jsonStore.ts
// ============================================================================
// Crash-safe writes and corruption handling for the JSON files in the profile
// folder (settings.json, memory.json).
//
//   - writes go to "<file>.tmp" first and are renamed over the target, so a
//     crash mid-write never leaves a half-written file behind
//   - the previous version is kept as "<file>.bak"
//   - a file that cannot be parsed is moved aside to "<file>.corrupt-<time>"
//     (never deleted, never silently overwritten) so the user can recover it
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Moves an unreadable file aside. Returns the new path, or null if that failed. */
export function quarantineFile(file: string): string | null {
  const target = `${file}.corrupt-${timestamp()}`;
  try {
    fs.renameSync(file, target);
    return target;
  } catch {
    return null;
  }
}

function backupExisting(file: string): void {
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // first write (nothing to back up) or the copy failed: not fatal
  }
}

export function writeJsonAtomicSync(file: string, value: unknown, keepBackup = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  if (keepBackup) backupExisting(file);
  fs.renameSync(tmp, file);
}

export async function writeJsonAtomic(file: string, value: unknown, keepBackup = false): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  if (keepBackup) backupExisting(file);
  await fs.promises.rename(tmp, file);
}
