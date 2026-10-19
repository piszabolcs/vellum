import { useLayoutEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useT } from '../i18n';

/** gap-2 between the two button groups */
const GROUP_GAP_PX = 8;

/**
 * Shows the title word only while the header has room for all of it. Hides it
 * when the row overflows, and shows it again once the free space between the
 * two button groups is wider than the word (measured while it was visible).
 */
function useWholeWord() {
  const rowRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const wordRef = useRef<HTMLSpanElement>(null);
  const wordWidth = useRef(0);
  const [visible, setVisible] = useState(true);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    const word = wordRef.current;
    if (!row || !left || !right || !word) return;
    const update = () => {
      if (visible) {
        wordWidth.current = word.getBoundingClientRect().width + parseFloat(getComputedStyle(word).marginRight);
        if (row.scrollWidth > row.clientWidth) setVisible(false);
      } else {
        const free = right.getBoundingClientRect().left - left.getBoundingClientRect().right - GROUP_GAP_PX;
        if (free >= wordWidth.current + 1) setVisible(true);
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => observer.disconnect();
  }, [visible]);

  return { rowRef, leftRef, rightRef, wordRef, visible };
}

interface Props {
  onCollapse: () => void;
  onOpenSettings: () => void;
  onOpenModels: () => void;
  onNewConversation: () => void;
  onCopyConversation: () => void;
  /** Igaz, amíg a "kimásolva" visszajelzés látszik. */
  copied: boolean;
  /** Nincs mit másolni / törölni – a beszélgetés-gombok ilyenkor tétlenek. */
  hasMessages: boolean;
  busy: boolean;
}

export default function Header({
  onCollapse,
  onOpenSettings,
  onOpenModels,
  onNewConversation,
  onCopyConversation,
  copied,
  hasMessages,
  busy
}: Props) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();
  const title = useWholeWord();

  return (
    <div data-header className="drag-region px-5 pb-3 pt-4">
      <div ref={title.rowRef} className="flex items-center justify-between gap-2">
        {/* Bal: cím + a beszélgetéshez tartozó műveletek */}
        <div ref={title.leftRef} className="flex shrink-0 items-center gap-2">
          {/* the title is the whole word or only the mark, never cut to "Vel…" */}
          <h1
            aria-label="Vellum"
            title="Vellum"
            className="flex shrink-0 items-center whitespace-nowrap font-display text-[16px] font-semibold tracking-wide text-text-primary"
          >
            <span ref={title.wordRef} className={`mr-1.5 ${title.visible ? '' : 'hidden'}`}>
              Vellum
            </span>
            <span className="text-[13px]" aria-hidden="true">🪶</span>
          </h1>
          <span className="h-4 w-px shrink-0 bg-white/15" />
          <div className="no-drag flex items-center gap-1">
            <HeaderButton
              title={t('panel.newConversation')}
              onClick={onNewConversation}
              disabled={busy || !hasMessages}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </HeaderButton>
            <HeaderButton
              title={copied ? t('panel.copied') : t('panel.copyConversation')}
              onClick={onCopyConversation}
              disabled={!hasMessages}
              active={copied}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </HeaderButton>
          </div>
        </div>

        {/* Jobb: ablak-műveletek */}
        <div ref={title.rightRef} className="no-drag flex shrink-0 items-center gap-1">
          <HeaderButton title={t('header.models')} onClick={onOpenModels}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
            </svg>
          </HeaderButton>
          <HeaderButton
            title={t('header.desktopLayout')}
            onClick={() => void updateSettings({ layout: 'desktop' })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          </HeaderButton>

          <span className="mx-0.5 h-4 w-px bg-white/15" />

          <HeaderButton
            title={settings.darkPersona ? t('header.darkModeOn') : t('header.darkModeOff')}
            active={settings.darkPersona}
            onClick={() => void updateSettings({ darkPersona: !settings.darkPersona })}
          >
            <span className="text-[13px] leading-none">
              {settings.darkPersona ? '😈' : '😄'}
            </span>
          </HeaderButton>

          <HeaderButton
            title={settings.alwaysOnTop ? t('header.pinOn') : t('header.pinOff')}
            active={settings.alwaysOnTop}
            onClick={() => void updateSettings({ alwaysOnTop: !settings.alwaysOnTop })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 17v5" />
              <path d="M9 3h6l1 7 2 3H6l2-3 1-7z" />
            </svg>
          </HeaderButton>
          <HeaderButton title={t('header.settings')} onClick={onOpenSettings}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </HeaderButton>
          <HeaderButton title={t('header.collapse')} onClick={onCollapse}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </HeaderButton>
        </div>
      </div>
    </div>
  );
}

function HeaderButton({
  title,
  active,
  disabled,
  onClick,
  children
}: {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors
        disabled:cursor-not-allowed disabled:opacity-30
        ${
          active
            ? 'border-vellum-bronze-light/50 bg-vellum-bronze-light/20 text-vellum-bronze-light'
            : 'border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary'
        }`}
    >
      {children}
    </button>
  );
}
