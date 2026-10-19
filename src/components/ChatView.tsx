import { useEffect, useRef } from 'react';
import { useChatStore } from '../store/useChatStore';
import { useT } from '../i18n';
import MessageBubble from './MessageBubble';
import ConfirmToolCard from './ConfirmToolCard';
import { useScrollFade } from '../utils/useScrollFade';

export default function ChatView() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const pendingConfirm = useChatStore((s) => s.pendingConfirm);
  const decideConfirm = useChatStore((s) => s.decideConfirm);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollFade(scrollRef);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending, pendingConfirm]);

  return (
    // A globális user-select:none (drag/gombok miatt kell) itt vissza van engedve,
    // hogy a saját üzeneteid, a statisztika és a keresési sorok is kijelölhetők legyenek.
    <div ref={scrollRef} className="scroll-fade chat-scroll flex-1 select-text space-y-3 overflow-y-auto px-5 py-2">
      {messages.length === 0 && <EmptyState />}

      {/* Streamelés közben a placeholder üzenet is itt jelenik meg – a
          gépelés-jelző a válaszkártyán belül van (AssistantResponseCard). */}
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}

      {/* A válasz generálása ITT áll meg, amíg nem döntesz. */}
      {pendingConfirm && (
        <ConfirmToolCard request={pendingConfirm} onDecide={decideConfirm} />
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <img
        src="./vellum_logo.png"
        alt=""
        className="mb-4 h-14 w-14 object-contain"
        draggable={false}
      />
      <h2 className="text-[16px] font-semibold text-text-primary">{t('empty.title')}</h2>
      <p className="mt-1.5 max-w-[280px] text-[12.5px] leading-relaxed text-text-secondary">
        {t('empty.subtitle')}
      </p>
    </div>
  );
}
