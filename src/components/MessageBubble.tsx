import type { ChatMessage } from '../types/chat';
import { useSettingsStore } from '../store/useSettingsStore';
import { useChatStore } from '../store/useChatStore';
import { useConversationsStore } from '../store/useConversationsStore';
import AssistantResponseCard from './AssistantResponseCard';
import { formatTime } from '../utils/formatting';
import { useT } from '../i18n';

interface Props {
  message: ChatMessage;
}

export default function MessageBubble({ message }: Props) {
  const showRouterDecision = useSettingsStore((s) => s.settings.showRouterDecision);
  const fork = useConversationsStore((s) => s.fork);
  const conversationId = useChatStore((s) => s.conversationId);
  const sending = useChatStore((s) => s.sending);
  const retryLast = useChatStore((s) => s.retryLast);
  const isLast = useChatStore((s) => s.messages[s.messages.length - 1]?.id === message.id);
  const settings = useSettingsStore((s) => s.settings);
  const t = useT();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          <div
            style={{
              backgroundImage:
                'linear-gradient(to bottom right, rgb(var(--vellum-bronze-light-rgb) / 0.9), rgb(var(--vellum-bronze-rgb)))'
            }}
            className="rounded-2xl rounded-br-md px-3.5 py-2.5 text-[13px] leading-relaxed text-white"
          >
            {message.content}
          </div>
          <p className="mt-1 text-right text-[10px] text-text-secondary/70">
            {formatTime(message.timestamp)}
          </p>
        </div>
      </div>
    );
  }

  if (message.error) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[92%]">
          <div className="rounded-2xl rounded-bl-md border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-danger">
            {message.content}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <p className="text-[10px] text-text-secondary/70">{formatTime(message.timestamp)}</p>
            {isLast && !sending && (
              <button
                onClick={() => void retryLast(settings)}
                className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[10.5px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
              >
                {t('chat.retry')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[95%]">
        <AssistantResponseCard
          content={message.content}
          thinking={message.thinking}
          stats={message.stats}
          streaming={message.streaming}
          searches={message.searches}
          contextFallback={message.contextFallback}
          timings={message.timings}
          toolCalls={message.toolCalls}
          sources={message.sources}
          routerDecision={message.routerDecision}
          showRouterDecision={showRouterDecision}
          selfConsistency={message.selfConsistency}
          // Streamelés közben nincs elágazás: a válasz még nincs az
          // adatbázisban, tehát nem lenne mit átmásolni.
          onFork={sending ? undefined : () => void fork(conversationId, message.id)}
        />
        <p className="mt-1 text-[10px] text-text-secondary/70">
          {formatTime(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
