import { useState } from 'react';
import Markdown from './Markdown';
import { useT } from '../i18n';
import { formatSeconds } from '../utils/formatting';
import ToolCallCard from './ToolCallCard';
import type { MessageTimings, OllamaStats } from '../types/chat';
import type { RouterDecision, SourceRef, ToolCallRecord } from '../types/bridge';

interface Props {
  content: string;
  thinking?: string;
  stats?: OllamaStats;
  streaming?: boolean;
  searches?: string[];
  contextFallback?: { from: number; to: number };
  timings?: MessageTimings;
  toolCalls?: ToolCallRecord[];
  sources?: SourceRef[];
  routerDecision?: RouterDecision;
  showRouterDecision?: boolean;
  /** ha meg van adva, megjelenik az "elágazás innen" gomb erre az üzenetre */
  onFork?: () => void;
  /** F11: ha több válaszból választottunk */
  selfConsistency?: { runs: number; chosen: number; reason: string | null };
}

export default function AssistantResponseCard({
  content,
  thinking,
  stats,
  streaming,
  searches,
  contextFallback,
  timings,
  toolCalls,
  sources,
  routerDecision,
  showRouterDecision,
  onFork,
  selfConsistency
}: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* vágólap nem elérhető */
    }
  };

  // Amíg semmi nem érkezett, a kártyán belül pötyögünk.
  const showTypingDots = streaming && !content && !thinking;

  return (
    <div className="glass-card overflow-hidden">
      {toolCalls && toolCalls.length > 0 && <ToolCallCard calls={toolCalls} />}
      {searches && searches.length > 0 && (
        <div className="border-b border-white/10 px-4 py-2">
          {searches.map((q, i) => (
            <p key={i} className="flex items-center gap-1.5 text-[10.5px] text-vellum-teal">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              {t('search.line', { query: q })}
            </p>
          ))}
        </div>
      )}

      {contextFallback && (
        <div className="border-b border-white/10 px-4 py-2">
          <p className="flex items-center gap-1.5 text-[10.5px] text-warning">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
            {t('context.fallback', { from: contextFallback.from, to: contextFallback.to })}
          </p>
        </div>
      )}

      {thinking && (
        <details className="border-b border-white/10 px-4 py-2">
          <summary className="cursor-pointer select-none text-[11px] font-medium uppercase tracking-wider text-vellum-teal">
            {t('thinking.label')}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-text-secondary">
            {thinking}
          </p>
        </details>
      )}

      <div className="px-4 py-3">
        {showTypingDots ? (
          <div className="flex items-center gap-1 py-1">
            <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-vellum-bronze-light" />
            <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-vellum-bronze-light" />
            <span className="typing-dot inline-block h-1.5 w-1.5 rounded-full bg-vellum-bronze-light" />
          </div>
        ) : (
          <Markdown content={content} />
        )}
      </div>

      {sources && sources.length > 0 && (
        <div className="border-t border-white/10 px-4 py-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary/60">
            {t('sources.title')}
          </p>
          {sources.map((source) => (
            <p key={source.id} className="truncate text-[10.5px] leading-relaxed">
              <span className="text-vellum-teal">[{source.id}]</span>{' '}
              <a
                href={source.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-text-secondary underline decoration-white/20 underline-offset-2 hover:text-text-primary"
              >
                {source.title || source.url}
              </a>
            </p>
          ))}
        </div>
      )}
      {showRouterDecision && routerDecision && (
        <p className="border-t border-white/10 px-4 py-1.5 text-[10px] text-text-secondary/50">
          {t('router.label')}: {t(`router.intent.${routerDecision.intent}` as never)}
          {routerDecision.needs_web ? ` · ${t('router.web')}` : ''}
          {routerDecision.needs_memory_search ? ` · ${t('router.memory')}` : ''}
          {` · ${t(`router.thinking.${routerDecision.thinking}` as never)}`}
          {routerDecision.skills.length > 0 ? ` · ${routerDecision.skills.join(', ')}` : ''}
        </p>
      )}
      {stats && (
        <p className="border-t border-white/10 px-4 py-1.5 text-[10px] text-text-secondary/60">
          {t('stats.line', {
            prompt: stats.promptTokens,
            eval: stats.evalTokens,
            tps: stats.tokensPerSecond
          })}
        </p>
      )}

      {selfConsistency && selfConsistency.runs > 1 && (
        <p
          className="border-t border-white/10 px-4 py-1.5 text-[10px] text-vellum-teal/80"
          title={selfConsistency.reason ?? undefined}
        >
          {t('stats.selfConsistency', { runs: selfConsistency.runs })}
        </p>
      )}

      {timings && (
        <p className="border-t border-white/10 px-4 py-1.5 text-[10px] text-text-secondary/60">
          {timings.thinkingMs !== undefined
            ? t('stats.timingsWithThinking', {
                think: formatSeconds(timings.thinkingMs),
                total: formatSeconds(timings.totalMs)
              })
            : t('stats.timingsTotal', { total: formatSeconds(timings.totalMs) })}
        </p>
      )}

      <div className="flex items-center justify-end gap-1 border-t border-white/10 px-4 py-2">
        {onFork && !streaming && (
          <button
            onClick={onFork}
            title={t('conv.fork')}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary
                       transition-colors hover:bg-white/10 hover:text-text-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="5" r="2" />
              <circle cx="6" cy="19" r="2" />
              <circle cx="18" cy="12" r="2" />
              <path d="M6 7v10M8 19h4a4 4 0 0 0 4-4v-1" />
            </svg>
          </button>
        )}
        <button
          onClick={() => void copy()}
          title={t('card.copy')}
          className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary
                     transition-colors hover:bg-white/10 hover:text-text-primary"
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
