import { describe, expect, it } from 'vitest';

import { isValidAccelerator } from './shared';
import { sanitizeStoredSettings, validateSettingsPatch } from './settingsValidation';

describe('validateSettingsPatch', () => {
  it('never lets the renderer set the file-tool root', () => {
    const { patch, rejected } = validateSettingsPatch({ filesRootPath: 'C:\\' });
    expect(patch).toEqual({});
    expect(rejected).toEqual(['filesRootPath']);
  });

  it('drops unknown keys, wrong types, bad enums and non-http hosts but keeps valid ones', () => {
    const { patch, rejected } = validateSettingsPatch({
      alwaysOnTop: 'yes',
      language: 'de',
      ollamaHost: 'file:///etc',
      ollamaContextSize: 12345,
      evil: true,
      largeText: true,
      ollamaModel: 'qwen3:8b',
    });
    expect(patch).toEqual({ largeText: true, ollamaModel: 'qwen3:8b' });
    expect(rejected.sort()).toEqual(
      ['alwaysOnTop', 'evil', 'language', 'ollamaContextSize', 'ollamaHost'].sort(),
    );
  });

  it('rejects a global hotkey without a real modifier', () => {
    expect(validateSettingsPatch({ globalHotkey: 'C' }).patch).toEqual({});
    expect(validateSettingsPatch({ globalHotkey: 'Ctrl+Alt+V' }).patch).toEqual({
      globalHotkey: 'Ctrl+Alt+V',
    });
  });
});

describe('sanitizeStoredSettings', () => {
  it('keeps well-typed known keys from settings.json and drops the rest', () => {
    expect(sanitizeStoredSettings({ largeText: true, layout: 'nope', junk: 1 })).toEqual({
      largeText: true,
    });
  });
});

describe('isValidAccelerator', () => {
  it('accepts modifier combinations and the empty "off" value only', () => {
    const valid = ['', 'Ctrl+Shift+Space', 'Alt+F1', 'CommandOrControl+K', 'Super+1'];
    const invalid = ['C', 'A', 'Shift+A', 'Ctrl+', 'Ctrl+Shift', 'Ctrl+A+B', 'Ctrl+Ctrl+A'];
    expect(valid.filter((a) => !isValidAccelerator(a))).toEqual([]);
    expect(invalid.filter((a) => isValidAccelerator(a))).toEqual([]);
  });
});
