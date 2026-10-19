import { describe, expect, it } from 'vitest';
import { parseGpuCsv } from './gpu';

describe('parseGpuCsv', () => {
  it('parzolja az nvidia-smi CSV sorát', () => {
    const info = parseGpuCsv('5821, 8188, 5, 52');
    expect(info).toEqual({
      memoryUsedMb: 5821,
      memoryTotalMb: 8188,
      utilizationPercent: 5,
      temperatureC: 52
    });
  });

  it('kezeli a záró sortörést és az extra szóközöket', () => {
    const info = parseGpuCsv('  1024,8188,0,40  \n');
    expect(info?.memoryUsedMb).toBe(1024);
    expect(info?.temperatureC).toBe(40);
  });

  it('null-t ad üres bemenetre', () => {
    expect(parseGpuCsv('')).toBeNull();
    expect(parseGpuCsv('   \n')).toBeNull();
  });

  it('null-t ad, ha hiányoznak mezők', () => {
    expect(parseGpuCsv('5821, 8188')).toBeNull();
  });

  it('null-t ad, ha nem szám az érték (pl. hibaüzenet)', () => {
    expect(parseGpuCsv('[N/A], [N/A], [N/A], [N/A]')).toBeNull();
  });
});
