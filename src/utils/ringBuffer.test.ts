import { describe, expect, it } from 'vitest';
import { pushSample } from './ringBuffer';

describe('pushSample', () => {
  it('a limiten belül egyszerűen hozzáfűz', () => {
    expect(pushSample([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });

  it('a limit elérésekor a legrégebbi mintát dobja el', () => {
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it('üres tömbből indulva is működik', () => {
    expect(pushSample([], 1, 3)).toEqual([1]);
  });

  it('nem módosítja az eredeti tömböt', () => {
    const original = [1, 2];
    pushSample(original, 3, 5);
    expect(original).toEqual([1, 2]);
  });
});
