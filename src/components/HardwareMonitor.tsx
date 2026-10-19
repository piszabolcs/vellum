import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { pushSample } from '../utils/ringBuffer';
import type { GpuInfo, RamInfo } from '../types/bridge';

// every poll starts an nvidia-smi process, so not more often than this
const POLL_MS = 3000;
const SPARKLINE_SAMPLES = 30;

function gb(mb: number): string {
  return (mb / 1024).toFixed(1);
}

// 8 GB-os kártyán a 90%+ azt jelzi, hogy a modell mindjárt CPU-ra szorul.
function barColorFor(ratio: number): string {
  return ratio > 0.9 ? 'bg-danger' : ratio > 0.75 ? 'bg-warning' : 'bg-vellum-bronze-light';
}

/** Kis, tengely és felirat nélküli grafikon az utolsó N mérésről. */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className="h-6 w-full" />;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 24 - ((v - min) / range) * 24;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full">
      <polyline
        points={points}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ stroke: color }}
      />
    </svg>
  );
}

interface Props {
  /** compact: a buborék-panel tetején (alapértelmezett). expanded: az asztali sidebarban, sparkline-okkal. */
  variant?: 'compact' | 'expanded';
}

/**
 * Élő hardver-sáv: VRAM (ha van NVIDIA GPU) + RAM + a betöltött modell neve és
 * az utolsó válasz tok/s-a. Csak a nyitott panelen él, így a poll magától
 * leáll, amikor a felhasználó buborékká csukja az appot.
 */
export default function HardwareMonitor({ variant = 'compact' }: Props) {
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [ram, setRam] = useState<RamInfo | null>(null);
  const [vramHistory, setVramHistory] = useState<number[]>([]);
  const [ramHistory, setRamHistory] = useState<number[]>([]);
  const [tpsHistory, setTpsHistory] = useState<number[]>([]);
  const t = useT();
  const model = useSettingsStore((s) => s.settings.ollamaModel);
  const lastStats = useChatStore((s) =>
    [...s.messages].reverse().find((m) => m.role === 'assistant' && m.stats)?.stats
  );

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      // a hidden window (tray, minimized) does not need live numbers
      if (document.hidden) return;
      const [nextGpu, nextRam] = await Promise.all([
        window.companion?.queryGpu() ?? Promise.resolve(null),
        window.companion?.queryRam() ?? Promise.resolve(null)
      ]);
      if (!cancelled) {
        setGpu(nextGpu);
        setRam(nextRam ?? null);
        if (variant === 'expanded') {
          if (nextGpu && nextGpu.memoryTotalMb > 0) {
            setVramHistory((prev) =>
              pushSample(prev, (nextGpu.memoryUsedMb / nextGpu.memoryTotalMb) * 100, SPARKLINE_SAMPLES)
            );
          }
          if (nextRam && nextRam.totalMb > 0) {
            setRamHistory((prev) =>
              pushSample(prev, (nextRam.usedMb / nextRam.totalMb) * 100, SPARKLINE_SAMPLES)
            );
          }
        }
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [variant]);

  useEffect(() => {
    if (variant === 'expanded' && lastStats) {
      setTpsHistory((prev) => pushSample(prev, lastStats.tokensPerSecond, SPARKLINE_SAMPLES));
    }
  }, [variant, lastStats]);

  if (!gpu && !ram) return null;

  const gpuRatio = gpu && gpu.memoryTotalMb > 0 ? gpu.memoryUsedMb / gpu.memoryTotalMb : 0;
  const gpuPercent = Math.min(100, Math.max(0, gpuRatio * 100));
  const ramRatio = ram && ram.totalMb > 0 ? ram.usedMb / ram.totalMb : 0;
  const ramPercent = Math.min(100, Math.max(0, ramRatio * 100));

  return (
    <div className="px-5 pb-2">
      <p className="mb-1 truncate text-[10px] tabular-nums text-text-secondary/70">
        {t('hardware.header', { model, tps: lastStats ? lastStats.tokensPerSecond : '—' })}
      </p>

      {gpu && (
        <>
          <p className="mb-1 text-[10px] tabular-nums text-text-secondary/70">
            {t('gpu.line', {
              used: gb(gpu.memoryUsedMb),
              total: gb(gpu.memoryTotalMb),
              util: gpu.utilizationPercent,
              temp: gpu.temperatureC
            })}
          </p>
          <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColorFor(gpuRatio)}`}
              style={{ width: `${gpuPercent}%` }}
            />
          </div>
          {variant === 'expanded' && (
            <div className="mb-1.5">
              <Sparkline values={vramHistory} color="rgb(var(--vellum-teal-rgb))" />
            </div>
          )}
        </>
      )}

      {ram && (
        <>
          <p className="mb-1 text-[10px] tabular-nums text-text-secondary/70">
            {t('ram.line', { used: gb(ram.usedMb), total: gb(ram.totalMb) })}
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={`h-full rounded-full transition-all duration-500 ${barColorFor(ramRatio)}`}
              style={{ width: `${ramPercent}%` }}
            />
          </div>
          {variant === 'expanded' && (
            <div className="mt-1.5">
              <Sparkline values={ramHistory} color="rgb(var(--vellum-bronze-light-rgb))" />
            </div>
          )}
        </>
      )}

      {variant === 'expanded' && tpsHistory.length > 1 && (
        <div className="mt-1.5">
          <Sparkline values={tpsHistory} color="var(--success)" />
        </div>
      )}
    </div>
  );
}
