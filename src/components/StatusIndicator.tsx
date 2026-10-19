import { useEffect, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useT } from '../i18n';

/** How often the footer re-checks the Ollama connection. */
const HEALTH_POLL_MS = 20_000;

type Health = 'checking' | 'ok' | 'model-missing' | 'unreachable';

/**
 * Real connection status in the panel footer (it used to say "local model"
 * even with Ollama down): polls /api/tags through the main process.
 */
export default function StatusIndicator() {
  const host = useSettingsStore((s) => s.settings.ollamaHost);
  const model = useSettingsStore((s) => s.settings.ollamaModel);
  const [health, setHealth] = useState<Health>('checking');
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (document.hidden) return;
      const result = await window.companion?.testOllama(host, model).catch(() => null);
      if (cancelled) return;
      if (result?.ok) setHealth('ok');
      else setHealth(result?.reachable ? 'model-missing' : 'unreachable');
    };
    setHealth('checking');
    void check();
    const timer = setInterval(() => void check(), HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [host, model]);

  const dot =
    health === 'ok'
      ? 'bg-success'
      : health === 'model-missing'
        ? 'bg-warning'
        : health === 'unreachable'
          ? 'bg-danger'
          : 'bg-white/30';
  const label =
    health === 'ok'
      ? `${t('status.local')} · ${model}`
      : health === 'model-missing'
        ? `${t('status.modelMissing')} · ${model}`
        : health === 'unreachable'
          ? t('status.unreachable')
          : t('status.checking');

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="status">
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dot}`} />
      <span className="truncate text-[11px] text-text-secondary">{label}</span>
    </div>
  );
}
