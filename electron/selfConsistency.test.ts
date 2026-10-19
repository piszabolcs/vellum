import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureSelfConsistency, pickBestAnswer } from './selfConsistency';

// A valasztas egyetlen modellhivas; azt mockoljuk a fetch szintjen, ahogy a
// tobbi teszt is teszi. Ami itt szamit: a VISSZAESES. Ha a valasztas barmiert
// nem sikerul, az elso valasznak kell nyernie -- az a self-consistency nelkuli
// viselkedes, tehat rosszabb nem lehet tole.

function mockChoice(payload: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => ({ message: { content: JSON.stringify(payload) } })
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pickBestAnswer', () => {
  it('egyetlen valasznal nem hiv modellt', async () => {
    // ha megis hivna, a fetch hianya dobna
    const result = await pickBestAnswer(['egyetlen']);
    expect(result.index).toBe(0);
    expect(result.chosen).toBe(false);
  });

  it('ures listara is biztonsagos erteket ad', async () => {
    const result = await pickBestAnswer([]);
    expect(result.index).toBe(0);
  });

  it('a modell valasztasat 1-tol szamozva erti', async () => {
    configureSelfConsistency({ host: 'http://localhost:11434', model: 'm' });
    mockChoice({ choice: 2, reason: 'ez teljesebb' });

    const result = await pickBestAnswer(['első', 'második', 'harmadik']);

    expect(result.index).toBe(1); // 2. valasz -> 1-es index
    expect(result.chosen).toBe(true);
    expect(result.reason).toBe('ez teljesebb');
  });

  it('tartomanyon kivuli valasztasnal az elsore esik vissza', async () => {
    configureSelfConsistency({ host: 'http://localhost:11434', model: 'm' });
    mockChoice({ choice: 9, reason: 'nincs ilyen' });

    const result = await pickBestAnswer(['első', 'második']);

    expect(result.index).toBe(0);
    expect(result.chosen).toBe(false);
  });

  it('nulla vagy negativ sorszamnal is az elso marad', async () => {
    configureSelfConsistency({ host: 'http://localhost:11434', model: 'm' });
    mockChoice({ choice: 0, reason: '' });

    const result = await pickBestAnswer(['első', 'második']);

    expect(result.index).toBe(0);
    expect(result.chosen).toBe(false);
  });

  it('halozati hiba eseten az elso valasz marad', async () => {
    configureSelfConsistency({ host: 'http://localhost:11434', model: 'm' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('nincs kapcsolat')));

    const result = await pickBestAnswer(['első', 'második']);

    expect(result.index).toBe(0);
    expect(result.chosen).toBe(false);
  });
});
