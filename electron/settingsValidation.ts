// ============================================================================
// vellum - settingsValidation.ts
// ============================================================================
// Validation for everything that changes AppSettings from outside the main
// process (the renderer over IPC, a hand-edited settings.json).
//
// The renderer is treated as untrusted: it may only send known keys with the
// right type, it can never set the file-tool root folder (that only comes from
// the native folder picker in the main process), and the global hotkey must be
// a real modifier combination.
// ============================================================================

import { AppSettings, CONTEXT_SIZE_OPTIONS, DEFAULT_SETTINGS, isValidAccelerator } from './shared';

const ENUMS: Partial<Record<keyof AppSettings, readonly string[]>> = {
  language: ['hu', 'en'],
  bubbleCorner: ['bottom-right', 'bottom-left'],
  layout: ['bubble', 'desktop'],
};

/** Keys the renderer may never write: they widen what the model can reach. */
const MAIN_ONLY_KEYS = new Set<keyof AppSettings>(['filesRootPath']);

function isKnownKey(key: string): key is keyof AppSettings {
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);
}

function hasValidShape(key: keyof AppSettings, value: unknown): boolean {
  const fallback: unknown = DEFAULT_SETTINGS[key];

  if (Array.isArray(fallback)) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }
  if (fallback !== null && typeof fallback === 'object') {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  if (typeof fallback === 'number') {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
  if (typeof value !== typeof fallback) return false;

  const allowed = ENUMS[key];
  return !allowed || allowed.includes(value as string);
}

function passesRules(key: keyof AppSettings, value: unknown): boolean {
  switch (key) {
    case 'ollamaContextSize':
      return (CONTEXT_SIZE_OPTIONS as readonly number[]).includes(value as number);
    case 'ollamaHost':
      return /^https?:\/\/[^\s/?#]+/i.test(value as string);
    case 'globalHotkey':
      return isValidAccelerator(value as string);
    default:
      return true;
  }
}

/** For settings.json: keeps every known, well-typed key (no IPC-only rules). */
export function sanitizeStoredSettings(raw: Record<string, unknown>): Partial<AppSettings> {
  const result: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isKnownKey(key) && hasValidShape(key, value)) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

export interface SettingsPatchResult {
  patch: Partial<AppSettings>;
  /** keys that were dropped, for logging */
  rejected: string[];
}

/** For `settings:update` from the renderer. */
export function validateSettingsPatch(raw: unknown): SettingsPatchResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { patch: {}, rejected: ['(payload is not an object)'] };
  }

  const patch: Partial<AppSettings> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      !isKnownKey(key) ||
      MAIN_ONLY_KEYS.has(key) ||
      !hasValidShape(key, value) ||
      !passesRules(key, value)
    ) {
      rejected.push(key);
      continue;
    }
    (patch as Record<string, unknown>)[key] = value;
  }

  return { patch, rejected };
}
