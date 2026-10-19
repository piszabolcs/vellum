import { execFile } from 'child_process';
import { promisify } from 'util';
import { GpuInfo } from './shared';

const execFileAsync = promisify(execFile);

/** Az nvidia-smi hívás időkorlátja – mérten ~190 ms, ez bőven elég. */
const QUERY_TIMEOUT_MS = 4_000;

const QUERY_ARGS = [
  '--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu',
  '--format=csv,noheader,nounits'
];

/**
 * Az `nvidia-smi ... --format=csv,noheader,nounits` egyetlen sorát parzolja,
 * pl. "5821, 8188, 5, 52". Bármi váratlan (üres, [N/A], hiányzó mező) → null.
 */
export function parseGpuCsv(raw: string): GpuInfo | null {
  const line = raw.trim().split('\n')[0]?.trim();
  if (!line) return null;

  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 4) return null;

  const numbers = parts.slice(0, 4).map((p) => Number(p));
  if (numbers.some((n) => !Number.isFinite(n))) return null;

  const [memoryUsedMb, memoryTotalMb, utilizationPercent, temperatureC] = numbers;
  return { memoryUsedMb, memoryTotalMb, utilizationPercent, temperatureC };
}

/**
 * Lekérdezi a GPU állapotát. Ha nincs nvidia-smi (nem NVIDIA gép), vagy bármi
 * hibázik, null-t ad – a UI ilyenkor egyszerűen elrejti a monitort.
 */
export async function queryGpu(): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', QUERY_ARGS, {
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true
    });
    return parseGpuCsv(stdout);
  } catch {
    return null;
  }
}
