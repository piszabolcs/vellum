import { useEffect, useState } from 'react';
import ChatView from './ChatView';
import InputBox from './InputBox';
import HardwareMonitor from './HardwareMonitor';
import ContextMeter from './ContextMeter';
import SettingsModal from './SettingsModal';
import ModelsModal from './ModelsModal';
import AppSignature from './AppSignature';
import ConversationList from './ConversationList';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useT } from '../i18n';

/** Below this window height the sidebar drops the hardware graphs, so the
 *  conversation list keeps room for several rows. */
const ROOMY_SIDEBAR_MIN_HEIGHT = 640;

/**
 * The desktop view: a large window shown on the taskbar, with a sidebar that
 * lists the archived conversations (SQLite, searchable). It reuses the chat
 * logic (useChatStore) and the same components as the bubble panel.
 */
export default function DesktopShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const sending = useChatStore((s) => s.sending);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const clearConversation = useChatStore((s) => s.clearConversation);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();
  const [roomy, setRoomy] = useState(() => window.innerHeight >= ROOMY_SIDEBAR_MIN_HEIGHT);

  useEffect(() => {
    const onResize = () => setRoomy(window.innerHeight >= ROOMY_SIDEBAR_MIN_HEIGHT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSend = (text: string) => {
    void sendMessage({ text, settings });
  };

  return (
    <div className="flex h-full w-full p-4">
      <div className="glass-panel panel-opaque flex h-full w-full flex-col overflow-hidden">
        <DesktopTitlebar
          onBackToBubble={() => void updateSettings({ layout: 'bubble' })}
          onOpenModels={() => setModelsOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/10 px-3 py-3">
            <div className="mb-3 flex items-center gap-2 px-1">
              <img
                src="./vellum_logo.png"
                alt=""
                className="h-7 w-7 object-contain"
                draggable={false}
              />
              <span className="font-display text-[15px] font-semibold text-text-primary">
                Vellum
              </span>
            </div>

            <button
              onClick={() => void clearConversation()}
              disabled={sending}
              className="mb-3 flex items-center justify-center rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 py-2 text-[12px] font-medium text-vellum-bronze-light transition-colors hover:bg-vellum-bronze-light/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('panel.newConversation')}
            </button>

            <ConversationList />

            <div className="mt-auto space-y-2 border-t border-white/10 pt-3">
              {roomy && <HardwareMonitor variant="expanded" />}
              <button
                onClick={() => setSettingsOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
                {t('header.settings')}
              </button>
              <div className="flex justify-center pt-1">
                <AppSignature />
              </div>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            <ContextMeter />
            <ChatView />
            <InputBox disabled={sending} onSend={handleSend} />
          </div>
        </div>

        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            onBrowseModels={() => {
              setSettingsOpen(false);
              setModelsOpen(true);
            }}
          />
        )}
        {modelsOpen && <ModelsModal onClose={() => setModelsOpen(false)} />}
      </div>
    </div>
  );
}

function DesktopTitlebar({ onBackToBubble, onOpenModels }: { onBackToBubble: () => void; onOpenModels: () => void }) {
  const t = useT();
  return (
    <div className="drag-region flex items-center justify-between border-b border-white/10 px-3 py-2">
      <span className="px-2 text-[12px] text-text-secondary/70">Vellum</span>
      <div className="no-drag flex items-center gap-1">
        <TitlebarButton title={t('header.models')} onClick={onOpenModels}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
          </svg>
        </TitlebarButton>
        <TitlebarButton title={t('header.bubbleLayout')} onClick={onBackToBubble}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="8" />
          </svg>
        </TitlebarButton>
        <span className="mx-1 h-4 w-px bg-white/15" />
        <TitlebarButton title={t('window.minimize')} onClick={() => window.companion?.minimizeWindow()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 12h14" />
          </svg>
        </TitlebarButton>
        <TitlebarButton title={t('window.maximize')} onClick={() => window.companion?.toggleMaximize()}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </TitlebarButton>
        <TitlebarButton title={t('window.close')} onClick={() => window.companion?.hideWindow()}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </TitlebarButton>
      </div>
    </div>
  );
}

function TitlebarButton({
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
      className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
    >
      {children}
    </button>
  );
}
