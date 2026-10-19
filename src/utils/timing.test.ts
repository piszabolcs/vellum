import { describe, expect, it } from 'vitest';
import { computeTimings } from './timing';

describe('computeTimings', () => {
  it('gondolkodás nélkül csak a teljes időt adja vissza', () => {
    const result = computeTimings({ start: 1000, end: 4500 });
    expect(result).toEqual({ totalMs: 3500 });
  });

  it('gondolkodással a gondolkodási időt is kiszámolja (első gondolkodás -> első válaszdarab)', () => {
    const result = computeTimings({
      start: 1000,
      firstThinking: 1200,
      firstContent: 3700,
      end: 5000
    });
    expect(result).toEqual({ totalMs: 4000, thinkingMs: 2500 });
  });

  it('ha csak firstThinking van (a modell sosem kezdett válaszolni), a thinkingMs elmarad', () => {
    const result = computeTimings({ start: 1000, firstThinking: 1500, end: 6000 });
    expect(result).toEqual({ totalMs: 5000 });
  });
});
