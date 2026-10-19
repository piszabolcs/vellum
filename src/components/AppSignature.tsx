import { useEffect, useRef, useState } from 'react';
import { useScrollFade } from '../utils/useScrollFade';
import { useSettingsStore } from '../store/useSettingsStore';
import { useT, type StringKey } from '../i18n';

/** Architecture layers shown in the app info card (top to bottom). */
const LAYERS: { name: string; role: StringKey }[] = [
  { name: 'Renderer', role: 'signature.layerRenderer' },
  { name: 'Preload bridge', role: 'signature.layerBridge' },
  { name: 'Main process', role: 'signature.layerMain' },
  { name: 'Ollama', role: 'signature.layerModel' }
];

const BUILT_WITH =
  'TypeScript · Electron · React · Vite · Tailwind · Zustand · better-sqlite3 · sqlite-vec (FTS5 + vectors) · zod · js-yaml · Ollama HTTP API';

/** Repositories the app is built on. The own repo is a placeholder until it is published. */
const REPOS: { name: string; url: string | null; note: StringKey }[] = [
  { name: 'Vellum', url: null, note: 'signature.repoOwn' },
  { name: 'Haverom', url: null, note: 'signature.repoBase' },
  { name: 'ollama/ollama', url: 'https://github.com/ollama/ollama', note: 'signature.repoOllama' },
  { name: 'asg017/sqlite-vec', url: 'https://github.com/asg017/sqlite-vec', note: 'signature.repoVec' },
  { name: 'WiseLibs/better-sqlite3', url: 'https://github.com/WiseLibs/better-sqlite3', note: 'signature.repoSqlite' }
];

/**
 * Author signature for the footer: `psz // v{version}`, version from
 * package.json (via app.getVersion() in the bootstrap). Bare text, accent glow
 * on hover and keyboard focus; click opens a compact app info card.
 */
export default function AppSignature() {
  const [open, setOpen] = useState(false);
  const version = useSettingsStore((s) => s.appVersion);
  const t = useT();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        title={t('signature.open')}
        className="signature-glow shrink-0 cursor-pointer text-[11px] text-text-secondary/70 transition-colors hover:text-vellum-teal focus-visible:text-vellum-teal"
      >
        psz // v{version || 'dev'}
      </button>
      {open && <AboutPopup version={version} onClose={() => setOpen(false)} />}
    </>
  );
}

function AboutPopup({ version, onClose }: { version: string; onClose: () => void }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollFade(bodyRef);
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center rounded-3xl bg-black/50"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="glass-panel panel-opaque mx-4 flex max-h-[92%] w-full max-w-[340px] flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-5">
          <div className="flex items-center gap-2">
            <img src="./vellum_logo.png" alt="" className="h-6 w-6 object-contain" draggable={false} />
            <h2 id="about-title" className="font-display text-[15px] font-semibold text-text-primary">
              Vellum <span className="text-[12px] font-normal text-text-secondary">v{version || 'dev'}</span>
            </h2>
          </div>
          <button
            onClick={onClose}
            title={t('signature.close')}
            aria-label={t('signature.close')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div ref={bodyRef} className="scroll-fade chat-scroll mb-3 mr-1.5 min-h-0 flex-1 overflow-y-auto pb-3 pl-5 pr-3.5">
        <p className="text-[12px] leading-relaxed text-text-secondary">{t('signature.purpose')}</p>

        <Section title={t('signature.layers')}>
          <ul className="space-y-1">
            {LAYERS.map((layer) => (
              <li key={layer.name} className="leading-snug">
                <span className="text-vellum-teal">{layer.name}</span>
                <span className="text-text-secondary"> — {t(layer.role)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={t('signature.builtWith')}>
          <p className="leading-snug text-text-secondary">{BUILT_WITH}</p>
        </Section>

        <Section title={t('signature.repos')}>
          <ul className="space-y-1">
            {REPOS.map((repo) => (
              <li key={repo.name} className="leading-snug text-text-secondary">
                {repo.url ? (
                  <a href={repo.url} target="_blank" rel="noreferrer noopener" className="text-vellum-teal hover:underline">
                    {repo.name}
                  </a>
                ) : (
                  <span className="text-text-primary">{repo.name}</span>
                )}
                <span> — {t(repo.note)}</span>
              </li>
            ))}
          </ul>
        </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3 text-[11.5px]">
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-secondary/60">{title}</p>
      {children}
    </div>
  );
}
