import { useEffect, useState } from 'react';
import FloatingBubble from './components/FloatingBubble';
import CompanionPanel from './components/CompanionPanel';
import DesktopShell from './components/DesktopShell';
import { useSettingsStore } from './store/useSettingsStore';
import { useChatStore } from './store/useChatStore';

export default function App() {
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bootstrap = useSettingsStore((s) => s.bootstrap);
  const loaded = useSettingsStore((s) => s.loaded);
  const highContrast = useSettingsStore((s) => s.settings.highContrast);
  const darkPersona = useSettingsStore((s) => s.settings.darkPersona);
  const language = useSettingsStore((s) => s.settings.language);
  const layout = useSettingsStore((s) => s.settings.layout);

  useEffect(() => {
    void bootstrap().then(() => {
      // A mentett beszélgetés visszatöltése (localStorage, majd adatbázis).
      void useChatStore.getState().restore();
    });
  }, [bootstrap]);

  // A main process ertesitesei (pl. a Haveromrol valo atallas uzenete).
  useEffect(() => {
    return window.companion?.onNotice((message) => setNotice(message));
  }, []);

  // Erős kontraszt mód: class a gyökér elemen (CSS override-ok).
  useEffect(() => {
    document.documentElement.classList.toggle('high-contrast', highContrast);
  }, [highContrast]);

  // "Dark Mode" persona: fekete-vörös téma a gyökér class-on keresztül.
  useEffect(() => {
    document.documentElement.classList.toggle('dark-persona', darkPersona);
  }, [darkPersona]);

  // A dokumentum nyelve a helyes szóelválasztáshoz / a11y-hoz.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const expand = async () => {
    // Előbb az ablakot méretezzük át, utána jelenik meg a panel.
    await window.companion?.setExpanded(true);
    setExpanded(true);
  };

  const collapse = async () => {
    setExpanded(false);
    await window.companion?.setExpanded(false);
  };

  if (!loaded) return null;

  const noticeBar = notice ? (
    <div className="pointer-events-auto absolute left-4 right-4 top-4 z-40 rounded-lg border border-vellum-teal/40 bg-vellum-teal/10 px-3 py-2 text-[11.5px] text-text-primary shadow-lg">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">{notice}</span>
        <button
          onClick={() => setNotice(null)}
          className="shrink-0 text-text-secondary hover:text-text-primary"
        >
          ✕
        </button>
      </div>
    </div>
  ) : null;

  if (layout === 'desktop') {
    return (
      <div className="relative h-full w-full">
        {noticeBar}
        <DesktopShell />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      {expanded && noticeBar}
      {expanded ? (
        <CompanionPanel onCollapse={() => void collapse()} />
      ) : (
        <FloatingBubble onOpen={() => void expand()} />
      )}
    </div>
  );
}
