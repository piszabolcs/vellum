import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useScrollFade } from '../utils/useScrollFade';
import { useChatStore } from '../store/useChatStore';
import { useConversationsStore } from '../store/useConversationsStore';
import { subscribeConversations } from '../store/conversationsBus';
import type { Conversation } from '../types/bridge';

/**
 * A beszelgetes-lista az asztali nezet sidebarjaban (F4).
 *
 * A kereses a gyors FTS csatornan megy (`conv:search`), ami gepeles kozbeni
 * hasznalatra valo. A JELENTES alapu keresest nem itt talalod: azt a modell
 * vegzi a `search_memory` eszkozzel, amikor a beszelgetes kozben szuksege van
 * ra -- ezert nincs kulon "szemantikus kereses" gomb.
 */
export default function ConversationList() {
  const listRef = useRef<HTMLDivElement>(null);
  useScrollFade(listRef);
  const t = useT();
  const items = useConversationsStore((s) => s.items);
  const results = useConversationsStore((s) => s.results);
  const query = useConversationsStore((s) => s.query);
  const showArchived = useConversationsStore((s) => s.showArchived);
  const refresh = useConversationsStore((s) => s.refresh);
  const search = useConversationsStore((s) => s.search);
  const setShowArchived = useConversationsStore((s) => s.setShowArchived);
  const select = useConversationsStore((s) => s.select);

  const currentId = useChatStore((s) => s.conversationId);
  const sending = useChatStore((s) => s.sending);

  useEffect(() => {
    void refresh();
    // a chat store akkor is valtoztat a listan, amikor mi nem tudunk rola
    // (uj beszelgetes, megjott az automatikus cim)
    return subscribeConversations(() => void refresh());
  }, [refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input
        value={query}
        onChange={(e) => void search(e.target.value)}
        placeholder={t('conv.searchPlaceholder')}
        className="mb-2 w-full rounded-lg border border-white/10 bg-[var(--vellum-input-bg)] px-2.5 py-1.5 text-[11.5px] text-text-primary placeholder:text-text-secondary/40 focus:border-vellum-bronze-light/60 focus:outline-none"
      />

      <div ref={listRef} className="scroll-fade chat-scroll mb-2 flex-1 space-y-1 overflow-y-auto">
        {results !== null ? (
          results.length === 0 ? (
            <p className="px-2.5 py-2 text-[11.5px] text-text-secondary/50">
              {t('conv.noResults')}
            </p>
          ) : (
            results.map((hit) => (
              <button
                key={hit.messageId}
                onClick={() => void select(hit.conversation.id)}
                disabled={sending}
                className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <span className="block truncate text-[12px] text-text-primary">
                  {hit.conversation.title || t('conv.untitled')}
                </span>
                <span className="mt-0.5 block truncate text-[10.5px] text-text-secondary/60">
                  {hit.snippet}
                </span>
              </button>
            ))
          )
        ) : items.length === 0 ? (
          <p className="px-2.5 py-2 text-[11.5px] text-text-secondary/50">{t('conv.empty')}</p>
        ) : (
          items.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === currentId}
              busy={sending}
            />
          ))
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2 px-1 pb-1 text-[10.5px] text-text-secondary/60">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => void setShowArchived(e.target.checked)}
          className="h-3 w-3 accent-vellum-bronze-light"
        />
        {t('conv.showArchived')}
      </label>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  busy
}: {
  conversation: Conversation;
  active: boolean;
  busy: boolean;
}) {
  const t = useT();
  const select = useConversationsStore((s) => s.select);
  const rename = useConversationsStore((s) => s.rename);
  const remove = useConversationsStore((s) => s.remove);
  const archive = useConversationsStore((s) => s.archive);
  const exportMarkdown = useConversationsStore((s) => s.exportMarkdown);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exported, setExported] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const label = conversation.title || t('conv.untitled');

  const commitRename = () => {
    setEditing(false);
    if (draft.trim() && draft !== conversation.title) void rename(conversation.id, draft);
    else setDraft(conversation.title);
  };

  const handleExport = async () => {
    const markdown = await exportMarkdown(conversation.id);
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    } catch {
      /* vágólap nem elérhető */
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') {
            setDraft(conversation.title);
            setEditing(false);
          }
        }}
        className="w-full rounded-lg border border-vellum-bronze-light/60 bg-[var(--vellum-input-bg)] px-2.5 py-2 text-[12px] text-text-primary focus:outline-none"
      />
    );
  }

  return (
    <div
      className={`group relative rounded-lg transition-colors ${
        active
          ? 'border border-vellum-bronze-light/30 bg-vellum-bronze-light/10'
          : 'border border-transparent hover:bg-white/5'
      }`}
    >
      <button
        onClick={() => void select(conversation.id)}
        onDoubleClick={() => setEditing(true)}
        disabled={busy}
        title={label}
        className="w-full px-2.5 py-2 text-left disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="block truncate pr-16 text-[12px] text-text-primary">{label}</span>
        <span className="mt-0.5 block text-[10px] text-text-secondary/50">
          {conversation.messageCount === 1
            ? t('conv.messageCountOne')
            : t('conv.messageCount', { n: conversation.messageCount })}
          {conversation.archived ? ` · ${t('conv.archived')}` : ''}
        </span>
      </button>

      {/* The actions appear on hover, and on keyboard focus of the row */}
      <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
        {confirmDelete ? (
          <>
            <RowButton title={t('conv.deleteConfirm')} onClick={() => void remove(conversation.id)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </RowButton>
            <RowButton title={t('conv.cancel')} onClick={() => setConfirmDelete(false)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </RowButton>
          </>
        ) : (
          <>
            <RowButton title={t('conv.rename')} onClick={() => setEditing(true)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </RowButton>
            <RowButton title={exported ? t('conv.exported') : t('conv.export')} onClick={() => void handleExport()}>
              {exported ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                </svg>
              )}
            </RowButton>
            <RowButton
              title={conversation.archived ? t('conv.unarchive') : t('conv.archive')}
              onClick={() => void archive(conversation.id, !conversation.archived)}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="4" rx="1" />
                <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
              </svg>
            </RowButton>
            <RowButton title={t('conv.delete')} onClick={() => setConfirmDelete(true)}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
              </svg>
            </RowButton>
          </>
        )}
      </div>
    </div>
  );
}

function RowButton({
  title,
  onClick,
  children
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded bg-black/30 text-text-secondary transition-colors hover:bg-black/50 hover:text-text-primary"
    >
      {children}
    </button>
  );
}
