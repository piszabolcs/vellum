import { useT } from '../i18n';
import type { ToolConfirmRequest } from '../types/bridge';

/**
 * Megerosito kartya destruktiv eszkozhivas elott (F6).
 *
 * Amig ez a kepernyon van, a valasz generalasa ALL -- a main oldalon egy nyitott
 * igeret var rank. Ezert latszik a chat aljan, es ezert nincs "kesobb" gomb:
 * dontesig nem megy tovabb semmi. Ha nem valaszolsz, ket perc utan a main
 * elutasitasnak veszi, hogy a beszelgetes ne ragadjon be orokre.
 */
export default function ConfirmToolCard({
  request,
  onDecide
}: {
  request: ToolConfirmRequest;
  onDecide: (approved: boolean) => void;
}) {
  const t = useT();

  // save_memory is the important case: show the type and its real effect
  // (facts are data, preferences/styles become instructions) and flag links,
  // a typical payload of an injected "remember this" request.
  const args = request.args as { type?: string; content?: string } | undefined;
  const isMemory = request.toolName === 'save_memory';
  const asInstruction = args?.type === 'style' || args?.type === 'preference';
  const hasLink = /https?:\/\/|www\./i.test(args?.content ?? '');
  const otherArgs = !isMemory ? JSON.stringify(request.args ?? {}, null, 1).slice(0, 400) : '';

  return (
    <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3">
      <p className="text-[12px] font-semibold text-warning">{t('confirm.title')}</p>

      <p className="mt-1 text-[12px] leading-relaxed text-text-primary">
        {isMemory
          ? t(asInstruction ? 'confirm.saveMemoryInstruction' : 'confirm.saveMemoryData', {
              type: args?.type ?? 'fact'
            })
          : t('confirm.generic', { tool: request.toolName })}
      </p>

      {isMemory && args?.content && (
        <p className="mt-2 rounded-lg bg-black/25 px-3 py-2 text-[12px] italic leading-relaxed text-text-secondary">
          {args.content}
        </p>
      )}
      {isMemory && hasLink && (
        <p className="mt-2 text-[11.5px] leading-snug text-warning">{t('confirm.linkWarning')}</p>
      )}
      {!isMemory && otherArgs !== '{}' && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 px-3 py-2 font-mono text-[11px] text-text-secondary">
          {otherArgs}
        </pre>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onDecide(true)}
          className="rounded-lg border border-vellum-bronze-light/50 bg-vellum-bronze-light/15 px-3 py-1.5 text-[12px] font-medium text-vellum-bronze-light transition-colors hover:bg-vellum-bronze-light/25"
        >
          {t('confirm.approve')}
        </button>
        <button
          onClick={() => onDecide(false)}
          className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          {t('confirm.deny')}
        </button>
      </div>
    </div>
  );
}
