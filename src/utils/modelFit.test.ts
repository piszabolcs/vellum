import { describe, expect, it } from 'vitest';
import { estimateFit } from './modelFit';

const PC = { vramGB: 8, ramGB: 32 };

describe('estimateFit', () => {
  it('fits in VRAM: weights x1.1 + KV cache + 0.5 GB against 90% of VRAM', () => {
    const result = estimateFit({ diskGB: 5.2, paramsB: 8 }, 8192, PC);
    expect(result.fit).toBe('gpu');
    expect(result.reason).toBe('fitsVram');
    expect(result.estimatedGB).toBe(6.7); // 5.72 + 0.48 + 0.5
    expect(result.usableVramGB).toBe(7.2);
    expect(result.usableRamGB).toBe(26);
  });

  it('scales the KV cache linearly with context and total parameters', () => {
    expect(estimateFit({ diskGB: 1, paramsB: 8 }, 1024, PC).kvCacheGB).toBe(0.1); // 0.06
    expect(estimateFit({ diskGB: 1, paramsB: 16 }, 16384, PC).kvCacheGB).toBe(1.9); // 0.06 * 16 * 2
  });

  it('spills to RAM when VRAM alone is not enough', () => {
    const result = estimateFit({ diskGB: 19, paramsB: 30, activeParamsB: 3 }, 8192, PC);
    expect(result.fit).toBe('gpu+ram');
    expect(result.reason).toBe('spillsToRam');
    expect(result.estimatedGB).toBe(23.2);
  });

  it('says no when VRAM + usable RAM is too small', () => {
    const result = estimateFit({ diskGB: 15, paramsB: 24 }, 8192, { vramGB: 0, ramGB: 16 });
    expect(result.fit).toBe('no');
    expect(result.reason).toBe('tooBig');
  });

  it('never says gpu without a GPU, and marks a RAM fit as RAM only', () => {
    const result = estimateFit({ diskGB: 0.8, paramsB: 1 }, 8192, { vramGB: 0, ramGB: 16 });
    expect(result.fit).toBe('gpu+ram');
    expect(result.reason).toBe('ramOnly');
  });

  it('flags MoE only when active parameters are at most 30% of the total', () => {
    expect(estimateFit({ diskGB: 19, paramsB: 30, activeParamsB: 3 }, 8192, PC).moe).toBe(true);
    expect(estimateFit({ diskGB: 19, paramsB: 30, activeParamsB: 10 }, 8192, PC).moe).toBe(false);
    expect(estimateFit({ diskGB: 5, paramsB: 8 }, 8192, PC).moe).toBe(false);
  });

  it('guesses the parameter count from the size when it is unknown (size-only)', () => {
    const sizeOnly = estimateFit({ diskGB: 4.8 }, 8192, PC);
    expect(sizeOnly).toEqual(estimateFit({ diskGB: 4.8, paramsB: 8 }, 8192, PC)); // 4.8 GB / 0.6
    expect(sizeOnly.fit).toBe('gpu');
    expect(estimateFit({ diskGB: 4.8, paramsB: NaN }, 8192, PC)).toEqual(sizeOnly);
  });

  it('keeps 6 GB of RAM for the system and never goes negative', () => {
    const result = estimateFit({ diskGB: 5.2, paramsB: 8 }, 8192, { vramGB: 4, ramGB: 4 });
    expect(result.usableRamGB).toBe(0);
    expect(result.fit).toBe('no');
  });
});
