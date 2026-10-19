import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, DEFAULT_SETTINGS } from './shared';
import { quarantineFile, writeJsonAtomicSync } from './jsonStore';
import { sanitizeStoredSettings } from './settingsValidation';

// JSON-file based settings store in the Electron userData folder.

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Where a corrupt settings.json was moved during the last load (for a notice). */
let corruptBackup: string | null = null;

export function takeSettingsLoadIssue(): string | null {
  const issue = corruptBackup;
  corruptBackup = null;
  return issue;
}

export function loadSettings(): AppSettings {
  let raw: string;
  try {
    // strip a BOM in case the file was edited by hand or by another tool
    raw = fs.readFileSync(settingsPath(), 'utf-8').replace(/^\uFEFF/, '');
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    // unknown keys and wrongly typed values fall back to the defaults
    return { ...DEFAULT_SETTINGS, ...sanitizeStoredSettings(parsed as Record<string, unknown>) };
  } catch {
    console.error('[vellum] settings.json is not valid, moving it aside');
    corruptBackup = quarantineFile(settingsPath()) ?? settingsPath();
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    writeJsonAtomicSync(settingsPath(), settings);
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}
