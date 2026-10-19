import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { CONTEXT_SIZE_OPTIONS } from '../types/settings';
import type { BubbleCorner, Language } from '../types/settings';
import { isValidAccelerator } from '../../electron/shared';
import { useT } from '../i18n';
import { useScrollFade } from '../utils/useScrollFade';
import MemoryEditor from './MemoryEditor';
import SkillManager from './SkillManager';

interface Props {
  onClose: () => void;
  /** opens the model browser (closes the settings) */
  onBrowseModels?: () => void;
}

type Tab = 'general' | 'model' | 'memory' | 'skills' | 'advanced';

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Settings, grouped into tabs (about 30 options).
 *
 * Layout: the title, the close button and the tab row stay fixed, only the tab
 * body scrolls. Esc closes the dialog, Tab stays inside it, and focus returns
 * to where it was when the dialog closes.
 *
 * Free-text fields are saved on blur / Enter, not per keystroke: every save
 * reconfigures the main process, so a half-typed host must never be applied.
 */
export default function SettingsModal({ onClose, onBrowseModels }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useScrollFade(bodyRef);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const t = useT();

  const [tab, setTab] = useState<Tab>('general');
  const [ollamaTest, setOllamaTest] = useState<{
    state: 'idle' | 'testing' | 'done';
    ok?: boolean;
    message?: string;
  }>({ state: 'idle' });
  const [copied, setCopied] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsUnavailable, setModelsUnavailable] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string>('');
  const [reindex, setReindex] = useState<{ running: boolean; result?: string }>({ running: false });
  const dialogRef = useRef<HTMLDivElement>(null);
  const testResultRef = useRef<HTMLParagraphElement>(null);

  // The modal remounts on every open, so the list is always fresh here.
  useEffect(() => {
    window.companion
      ?.listModels(settings.ollamaHost)
      .then((names) => {
        setModelOptions(names);
        setModelsUnavailable(names.length === 0);
      })
      .catch(() => setModelsUnavailable(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the main process builds the diagnostics (ollama ps, version, env, db)
  useEffect(() => {
    void window.companion?.diagnostics
      .run()
      .then((result) => setDiagnostics(result.rawText))
      .catch(() => setDiagnostics(''));
  }, []);

  // Esc closes; focus moves into the dialog and back out when it closes
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (ollamaTest.state === 'done') testResultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [ollamaTest.state]);

  const trapFocus = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const testOllama = async () => {
    setOllamaTest({ state: 'testing' });
    const res = await window.companion
      ?.testOllama(settings.ollamaHost, settings.ollamaModel)
      .catch(() => undefined);
    setOllamaTest({ state: 'done', ok: res?.ok ?? false, message: res?.message ?? '—' });
  };

  const diagnosticsText = diagnostics || t('settings.diagnosticsUnavailable');

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticsText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  };

  const rebuildIndex = async () => {
    setReindex({ running: true });
    const result = await window.companion?.index.rebuild().catch(() => null);
    setReindex({
      running: false,
      result: result?.ok
        ? t('settings.rebuildIndexDone', { n: result.indexed })
        : t('settings.rebuildIndexFailed', { reason: result?.error ?? '—' })
    });
  };

  const inputClass =
    'w-full rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-2 text-[12.5px] text-text-primary placeholder:text-text-secondary/40 focus:border-vellum-bronze-light/60 focus:outline-none';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'general', label: t('settings.tabGeneral') },
    { id: 'model', label: t('settings.tabModel') },
    { id: 'memory', label: t('settings.tabMemory') },
    { id: 'skills', label: t('settings.tabSkills') },
    { id: 'advanced', label: t('settings.tabAdvanced') }
  ];

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center rounded-3xl bg-black/50"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="glass-panel panel-opaque mx-4 flex max-h-[90%] w-full max-w-[680px] flex-col overflow-hidden focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* fixed part: title, close button, tabs */}
        <div className="shrink-0 px-5 pt-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="settings-title" className="font-display text-[16px] font-semibold text-text-primary">
              {t('settings.title')}
            </h2>
            <button
              onClick={onClose}
              title={t('settings.close')}
              aria-label={t('settings.close')}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-text-secondary hover:bg-white/10 hover:text-text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div role="tablist" className="mb-4 flex gap-0.5 overflow-x-auto rounded-lg border border-white/10 bg-white/5 p-0.5">
            {tabs.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={`flex-1 whitespace-nowrap rounded-md px-1 py-1.5 text-[11.5px] font-medium transition-colors ${
                  tab === item.id
                    ? 'bg-vellum-bronze-light/25 text-vellum-bronze-light'
                    : 'text-text-secondary hover:bg-white/10 hover:text-text-primary'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* scrolling body */}
        <div ref={bodyRef} role="tabpanel" className="scroll-fade chat-scroll mb-3 mr-1.5 min-h-0 flex-1 overflow-y-auto pb-4 pl-5 pr-3.5">
          {/* ---------------- GENERAL ---------------- */}
          {tab === 'general' && (
            <div className="space-y-4">
              <Field label={t('settings.language')}>
                <Segmented
                  value={settings.language}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'hu', label: 'Magyar' }
                  ]}
                  onChange={(v) => void updateSettings({ language: v as Language })}
                />
              </Field>

              <Toggle
                label={t('settings.alwaysOnTop')}
                checked={settings.alwaysOnTop}
                onChange={(v) => void updateSettings({ alwaysOnTop: v })}
              />
              <Toggle
                label={t('settings.startWithWindows')}
                checked={settings.startWithWindows}
                onChange={(v) => void updateSettings({ startWithWindows: v })}
              />
              <Toggle
                label={t('settings.largeText')}
                checked={settings.largeText}
                onChange={(v) => void updateSettings({ largeText: v })}
              />
              <Toggle
                label={t('settings.highContrast')}
                checked={settings.highContrast}
                onChange={(v) => void updateSettings({ highContrast: v })}
              />

              <Field label={t('settings.bubbleCorner')} htmlFor="set-corner">
                <select
                  id="set-corner"
                  value={settings.bubbleCorner}
                  onChange={(e) =>
                    void updateSettings({ bubbleCorner: e.target.value as BubbleCorner })
                  }
                  className={inputClass}
                >
                  <option value="bottom-right">{t('settings.cornerBR')}</option>
                  <option value="bottom-left">{t('settings.cornerBL')}</option>
                </select>
              </Field>
            </div>
          )}

          {/* ---------------- MODEL ---------------- */}
          {tab === 'model' && (
            <div className="space-y-4">
              <Field label={t('settings.ollamaHost')} htmlFor="set-host">
                <CommitInput
                  id="set-host"
                  value={settings.ollamaHost}
                  onCommit={(v) => void updateSettings({ ollamaHost: v.trim() })}
                  placeholder="http://localhost:11434"
                  className={inputClass}
                />
              </Field>

              <Field label={t('settings.ollamaModel')} htmlFor="set-model">
                <CommitInput
                  id="set-model"
                  value={settings.ollamaModel}
                  onCommit={(v) => void updateSettings({ ollamaModel: v.trim() })}
                  placeholder="qwen3:8b"
                  list="model-options"
                  className={inputClass}
                />
                <datalist id="model-options">
                  {modelOptions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <Help>{t('settings.ollamaModelHelp')}</Help>
                {modelsUnavailable && <Help>{t('settings.modelListEmpty')}</Help>}
                {onBrowseModels && (
                  <button
                    onClick={onBrowseModels}
                    className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
                  >
                    {t('models.browse')}
                  </button>
                )}
              </Field>

              <Field label={t('settings.helperModel')} htmlFor="set-helper">
                <CommitInput
                  id="set-helper"
                  value={settings.helperModel}
                  onCommit={(v) => void updateSettings({ helperModel: v.trim() })}
                  placeholder={settings.ollamaModel}
                  list="model-options"
                  className={inputClass}
                />
                <Help>{t('settings.helperModelHelp')}</Help>
              </Field>

              <Field label={t('settings.contextSize')} htmlFor="set-ctx">
                <select
                  id="set-ctx"
                  value={settings.ollamaContextSize}
                  onChange={(e) => void updateSettings({ ollamaContextSize: Number(e.target.value) })}
                  className={inputClass}
                >
                  {CONTEXT_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
                <Help>{t('settings.contextSizeHelp')}</Help>
              </Field>

              <Field label={t('settings.idleTimeout')} htmlFor="set-idle">
                <CommitInput
                  id="set-idle"
                  type="number"
                  min={0}
                  step={30}
                  value={String(settings.ollamaIdleTimeoutSec)}
                  onCommit={(v) =>
                    void updateSettings({ ollamaIdleTimeoutSec: Math.max(0, Number(v) || 0) })
                  }
                  className={inputClass}
                />
                <Help>{t('settings.idleTimeoutHelp')}</Help>
              </Field>

              <button
                onClick={() => void testOllama()}
                disabled={ollamaTest.state === 'testing'}
                className="w-full rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 py-2 text-[12px] font-medium text-vellum-bronze-light transition-colors hover:bg-vellum-bronze-light/20 disabled:opacity-40"
              >
                {ollamaTest.state === 'testing' ? t('settings.testing') : t('settings.testConnection')}
              </button>
              {ollamaTest.state === 'done' && (
                <p
                  ref={testResultRef}
                  role="status"
                  className={`text-[11px] leading-snug ${ollamaTest.ok ? 'text-success' : 'text-danger'}`}
                >
                  {ollamaTest.message}
                </p>
              )}
            </div>
          )}

          {/* ---------------- MEMORY ---------------- */}
          {tab === 'memory' && <MemoryEditor />}

          {/* ---------------- SKILLS ---------------- */}
          {tab === 'skills' && (
            <div className="space-y-4">
              <div>
                <Toggle
                  label={t('settings.skills')}
                  checked={settings.skillsEnabled}
                  onChange={(v) => void updateSettings({ skillsEnabled: v })}
                />
                <Help>{t('settings.skillsHelp')}</Help>
              </div>
              <SkillManager />
            </div>
          )}

          {/* ---------------- ADVANCED ---------------- */}
          {tab === 'advanced' && (
            <div className="space-y-4">
              <div>
                <Toggle
                  label={t('settings.webSearch')}
                  checked={settings.webSearchEnabled}
                  onChange={(v) => void updateSettings({ webSearchEnabled: v })}
                />
                <Help>{t('settings.webSearchHelp')}</Help>
              </div>

              <div>
                <Toggle
                  label={t('settings.deepSearch')}
                  checked={settings.deepSearchEnabled}
                  onChange={(v) => void updateSettings({ deepSearchEnabled: v })}
                />
                <Help>{t('settings.deepSearchHelp')}</Help>
              </div>

              <div>
                <Toggle
                  label={t('settings.englishSearchQueries')}
                  checked={settings.englishSearchQueries}
                  onChange={(v) => void updateSettings({ englishSearchQueries: v })}
                />
                <Help>{t('settings.englishSearchQueriesHelp')}</Help>
              </div>

              <Divider />

              <div>
                <Toggle
                  label={t('settings.router')}
                  checked={settings.routerEnabled}
                  onChange={(v) => void updateSettings({ routerEnabled: v })}
                />
                <Help>{t('settings.routerHelp')}</Help>
              </div>

              <Toggle
                label={t('settings.showRouterDecision')}
                checked={settings.showRouterDecision}
                onChange={(v) => void updateSettings({ showRouterDecision: v })}
              />

              <Field label={t('settings.thinkingBudget')} htmlFor="set-budget">
                <CommitInput
                  id="set-budget"
                  type="number"
                  min={0}
                  step={500}
                  value={String(settings.thinkingBudgetTokens)}
                  onCommit={(v) =>
                    void updateSettings({ thinkingBudgetTokens: Math.max(0, Number(v) || 0) })
                  }
                  className={inputClass}
                />
                <Help>{t('settings.thinkingBudgetHelp')}</Help>
              </Field>

              <div>
                <Toggle
                  label={t('settings.selfConsistency')}
                  checked={settings.selfConsistencyEnabled}
                  onChange={(v) => void updateSettings({ selfConsistencyEnabled: v })}
                />
                <Help>{t('settings.selfConsistencyHelp', { k: settings.selfConsistencyK })}</Help>
              </div>

              <Field label={t('settings.globalHotkey')}>
                <HotkeyField
                  value={settings.globalHotkey}
                  inputClass={inputClass}
                  onApply={(v) => void updateSettings({ globalHotkey: v })}
                />
                <Help>{t('settings.globalHotkeyHelp')}</Help>
              </Field>

              <Divider />

              <div>
                <Toggle
                  label={t('settings.compaction')}
                  checked={settings.compactionEnabled}
                  onChange={(v) => void updateSettings({ compactionEnabled: v })}
                />
                <Help>{t('settings.compactionHelp')}</Help>
              </div>

              <Field label={t('settings.embeddingModel')} htmlFor="set-embed">
                <CommitInput
                  id="set-embed"
                  value={settings.embeddingModel}
                  onCommit={(v) => void updateSettings({ embeddingModel: v.trim() })}
                  placeholder="bge-m3"
                  className={inputClass}
                />
                <Help>{t('settings.embeddingModelHelp')}</Help>
              </Field>

              <div>
                <button
                  onClick={() => void rebuildIndex()}
                  disabled={reindex.running}
                  className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[12px] text-text-primary hover:bg-white/10 disabled:opacity-40"
                >
                  {t('settings.rebuildIndex')}
                </button>
                <Help>{reindex.result ?? t('settings.rebuildIndexHelp')}</Help>
              </div>

              <Divider />

              <Field label={t('settings.filesRoot')}>
                <div className="flex gap-1.5">
                  <span className="min-w-0 flex-1 truncate rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-2 text-[12px] text-text-secondary">
                    {settings.filesRootPath || t('settings.filesRootNone')}
                  </span>
                  <button
                    onClick={() => void window.companion?.tools.pickFilesRoot()}
                    className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-3 text-[12px] text-text-primary hover:bg-white/10"
                  >
                    {t('settings.filesRootPick')}
                  </button>
                </div>
                <Help>{t('settings.filesRootHelp')}</Help>
              </Field>

              <Divider />

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">
                    {t('settings.diagnostics')}
                  </span>
                  <button
                    onClick={() => void copyDiagnostics()}
                    className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[10.5px] text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
                  >
                    {copied ? t('settings.copied') : t('settings.copy')}
                  </button>
                </div>
                <pre className="chat-scroll max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-[var(--vellum-diag-bg)] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-text-secondary">
                  {diagnosticsText}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A text/number input that only reports its value on blur or Enter. */
function CommitInput({
  value,
  onCommit,
  ...rest
}: { value: string; onCommit: (value: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange'
>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape' && draft !== value) {
          // first Esc reverts the edit, the next one closes the dialog
          e.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);
const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace'
};

/** Builds an Electron accelerator ("Ctrl+Shift+Space") from a key press. */
function acceleratorFromEvent(e: React.KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = `num${e.code.slice(6)}`;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else key = NAMED_KEYS[e.key] ?? null;
  if (!key) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

/**
 * Global hotkey picker. Nothing is registered while you type: press "Change",
 * press the combination, then "Apply". A combination needs Ctrl, Alt or Win.
 */
function HotkeyField({
  value,
  inputClass,
  onApply
}: {
  value: string;
  inputClass: string;
  onApply: (value: string) => void;
}) {
  const t = useT();
  const [capturing, setCapturing] = useState(false);
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);
  const valid = isValidAccelerator(draft);

  const stop = () => {
    setCapturing(false);
    setDraft(value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stop();
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setDraft('');
      return;
    }
    const accelerator = acceleratorFromEvent(e);
    if (accelerator) setDraft(accelerator);
  };

  return (
    <div>
      <div className="flex gap-1.5">
        <div
          ref={boxRef}
          tabIndex={0}
          role="textbox"
          aria-readonly="true"
          aria-label={t('settings.globalHotkey')}
          onKeyDown={onKeyDown}
          className={`${inputClass} min-w-0 flex-1 truncate ${capturing ? 'border-vellum-bronze-light/60' : ''}`}
        >
          {capturing ? draft || t('settings.hotkeyPress') : value || t('settings.hotkeyOff')}
        </div>
        {capturing ? (
          <>
            <button
              disabled={!valid || draft === value}
              onClick={() => {
                onApply(draft);
                setCapturing(false);
              }}
              className="shrink-0 rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 text-[12px] text-vellum-bronze-light hover:bg-vellum-bronze-light/20 disabled:opacity-40"
            >
              {t('settings.hotkeyApply')}
            </button>
            <button
              onClick={stop}
              className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-3 text-[12px] text-text-primary hover:bg-white/10"
            >
              {t('settings.hotkeyCancel')}
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setDraft('');
              setCapturing(true);
              boxRef.current?.focus();
            }}
            className="shrink-0 rounded-lg border border-white/15 bg-white/5 px-3 text-[12px] text-text-primary hover:bg-white/10"
          >
            {t('settings.hotkeyChange')}
          </button>
        )}
      </div>
      {capturing && draft !== '' && !valid && (
        <p className="mt-1.5 text-[11px] leading-snug text-danger">{t('settings.hotkeyNeedsModifier')}</p>
      )}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-text-secondary"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function Help({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11px] leading-snug text-text-secondary/70">{children}</p>;
}

function Divider() {
  return <div className="h-px bg-white/10" />;
}

function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="flex gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
            value === opt.value
              ? 'bg-vellum-bronze-light/25 text-vellum-bronze-light'
              : 'text-text-secondary hover:bg-white/10 hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-left transition-colors hover:bg-white/10"
    >
      <span className="text-[12.5px] text-text-primary">{label}</span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-vellum-bronze-light' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            checked ? 'left-[18px]' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  );
}
