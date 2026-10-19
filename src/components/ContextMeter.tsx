import { useT } from '../i18n';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { contextUsage, levelFromRatio, measuredUsed } from '../utils/contextUsage';

/**
 * A kontextus-kihasznaltsag savja (F5).
 *
 * MIERT KELL: e nelkul a felhasznalo csak annyit lat, hogy a modell "hirtelen
 * elhulyult" -- pedig valojaban betelt a kontextus, es az Ollama NEMAN levagta
 * a beszelgetes elejet. Ez a sav lathatova teszi az okot.
 *
 * A hatarok (60% / 75%) nem onkenyesek: 80% folott a kovetkeztetes minosege
 * merhetoen romlik, ezert 75%-nal mar indul a compaction.
 */
export default function ContextMeter() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const summary = useChatStore((s) => s.summary);
  const numCtx = useSettingsStore((s) => s.settings.ollamaContextSize);
  const locale = useSettingsStore((s) => (s.settings.language === 'hu' ? 'hu-HU' : 'en-US'));

  const estimate = contextUsage(messages, numCtx, summary);

  // Az elso valasz utan mar van valodi meres -- azt hasznaljuk, mert a becsles
  // nem lat bele a memoriaba, a rendszer-retegekbe es a behuzott forrasokba.
  const measured = measuredUsed(messages);
  const used = measured ?? estimate.used;
  const ratio = numCtx > 0 ? used / numCtx : 0;
  const level = levelFromRatio(ratio);
  const percent = Math.min(100, Math.max(0, ratio * 100));

  const barColor =
    level === 'critical' ? 'bg-danger' : level === 'warn' ? 'bg-warning' : 'bg-vellum-teal';

  // Mert ertek mellett nem bontjuk szet: az Ollama egyetlen szamot ad, es a
  // retegekre bontas ott mar csak talalgatas lenne.
  const breakdown = measured
    ? t('context.measured')
    : [
        t('context.breakdownSystem', { n: estimate.breakdown.system }),
        t('context.breakdownMemory', { n: estimate.breakdown.memory }),
        t('context.breakdownHistory', { n: estimate.breakdown.history }),
        t('context.breakdownRetrieved', { n: estimate.breakdown.retrieved })
      ].join('\n');

  return (
    <div className="px-5 pb-1.5" title={breakdown}>
      <p className="mb-1 text-[10px] tabular-nums text-text-secondary/70">
        {t('context.line', {
          used: used.toLocaleString(locale),
          total: numCtx.toLocaleString(locale),
          percent: percent.toFixed(0)
        })}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
