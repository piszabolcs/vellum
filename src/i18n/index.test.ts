import { describe, expect, it } from 'vitest';

import { dictionaries } from './index';

describe('renderer i18n', () => {
  it('has an English text for every key (English is the default language)', () => {
    const missing = Object.keys(dictionaries.hu).filter(
      (key) => !(dictionaries.en as Record<string, string | undefined>)[key],
    );
    expect(missing).toEqual([]);
  });
});
