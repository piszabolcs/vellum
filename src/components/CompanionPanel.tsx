import { useEffect, useState } from 'react';
import Header from './Header';
import HardwareMonitor from './HardwareMonitor';
import ContextMeter from './ContextMeter';
import ChatView from './ChatView';
import InputBox from './InputBox';
import SettingsModal from './SettingsModal';
import ModelsModal from './ModelsModal';
import StatusIndicator from './StatusIndicator';
import AppSignature from './AppSignature';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { conversationToMarkdown } from '../utils/transcript';

interface Props {
  onCollapse: () => void;
}

export default function CompanionPanel({ onCollapse }: Props) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [conversationCopied, setConversationCopied] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const sending = useChatStore((s) => s.sending);
  const messages = useChatStore((s) => s.messages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const clearConversation = useChatStore((s) => s.clearConversation);
  const settings = useSettingsStore((s) => s.settings);

  // Aktív ablak (fókusz vagy egér fölötte) → fedő háttér, inaktív → áttetsző.
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const opaque = hovered || focused;

  const handleSend = (text: string) => {
    void sendMessage({ text, settings });
  };

  const copyConversation = async () => {
    try {
      await navigator.clipboard.writeText(conversationToMarkdown(messages, settings.language));
      setConversationCopied(true);
      setTimeout(() => setConversationCopied(false), 1500);
    } catch {
      /* vágólap nem elérhető */
    }
  };

  const alignClass = settings.bubbleCorner === 'bottom-left' ? 'justify-start' : 'justify-end';

  return (
    <div
      className={`flex h-full w-full items-end ${alignClass} p-4`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`glass-panel panel-in relative flex h-full w-full flex-col overflow-hidden ${
          opaque ? 'panel-opaque' : 'panel-translucent'
        }`}
      >
        <Header
          onCollapse={onCollapse}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenModels={() => setModelsOpen(true)}
          onNewConversation={() => void clearConversation()}
          onCopyConversation={() => void copyConversation()}
          copied={conversationCopied}
          hasMessages={messages.length > 0}
          busy={sending}
        />
        <HardwareMonitor />
        <ContextMeter />
        <ChatView />
        <InputBox disabled={sending} onSend={handleSend} />

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-2">
          <StatusIndicator />
          <AppSignature />
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
