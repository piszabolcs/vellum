import { useT } from '../i18n';
import type { ToolCallRecord } from '../types/bridge';

/**
 * Az eszkozhivasok megjelenitese a valaszkartya tetejen (F6).
 *
 * MIERT LATSZIK: a router es a guardrail-reteg csendben dolgozik, es ha rosszul
 * dont, a felhasznalo csak egy rossz valaszt lat -- nem derul ki, hogy a
 * DONTES volt a hibas. Ez a sor teszi lathatova, mi tortent valojaban.
 *
 * A javito korok (nudge) is latszanak, mert azok jelzik, hogy a modell elsore
 * elrontotta a hivast -- ez hasznos jel, ha egy eszkoz leirasat kell javitani.
 */

const TOOL_ICONS: Record<string, string> = {
  web_search: '🔍',
  get_datetime: '📅',
  calculate: '🧮',
  search_memory: '💭',
  save_memory: '📝',
  load_skill: '📚',
  read_artifact: '📄',
  read_file: '📁',
  list_directory: '📂'
};

export default function ToolCallCard({ calls }: { calls: ToolCallRecord[] }) {
  const t = useT();
  if (calls.length === 0) return null;

  return (
    <div className="border-b border-white/10 px-4 py-2">
      {calls.map((call, i) => (
        <p
          key={`${call.name}-${i}`}
          className={`flex items-center gap-1.5 text-[10.5px] ${
            call.ok ? 'text-vellum-teal' : 'text-warning'
          }`}
        >
          <span className="shrink-0">{TOOL_ICONS[call.name] ?? '🔧'}</span>
          <span className="font-medium">{call.name}</span>
          {call.ok ? (
            <span className="text-text-secondary/60">
              {call.durationMs > 0 ? t('unit.seconds', { n: (call.durationMs / 1000).toFixed(1) }) : ''}
              {call.artifactId ? ` · ${t('tool.offloaded')}` : ''}
            </span>
          ) : (
            <span className="text-text-secondary/60">{call.error ?? t('tool.failed')}</span>
          )}
        </p>
      ))}
    </div>
  );
}
