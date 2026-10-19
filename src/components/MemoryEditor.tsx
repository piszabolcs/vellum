import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { MemoryCandidate, MemoryEntry, MemoryEntryType } from '../types/bridge';

/**
 * A memoria v2 szerkesztoje (F3).
 *
 * MIERT NEM EGY TEXTAREA, mint korabban: a bejegyzes TIPUSA donti el, hova
 * kerul a promptban. A tenyek (fact/person/project) ADATKERETBE mennek, a
 * stilus-utasitasok (style/preference) pedig kozvetlenul a friss uzenet ELE --
 * ezert kell tipust valasztani, nem eleg szabad szoveget irni.
 *
 * A javaslatok (candidates) kulon szekcioban vannak: a modell javasolhat, de
 * jovahagyas nelkul SEMMI nem kerul a memoriaba. Jovahagyas nelkul a memoria
 * fel ev alatt szemetdomb lenne, es a modell viselkedese kiszamithatatlanna valna.
 */

const TYPE_ORDER: MemoryEntryType[] = ['style', 'preference', 'fact', 'person', 'project'];

export default function MemoryEditor() {
  const t = useT();
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [estimate, setEstimate] = useState<{ tokens: number; warn: boolean; overHardLimit: boolean } | null>(
    null
  );
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);

  // uj bejegyzes urlapja
  const [newType, setNewType] = useState<MemoryEntryType>('fact');
  const [newContent, setNewContent] = useState('');

  const refresh = async () => {
    const bridge = window.companion;
    if (!bridge) return;
    const [list, cands, est] = await Promise.all([
      bridge.memory.list(),
      bridge.memory.candidates(),
      bridge.memory.estimate()
    ]);
    setEntries(list);
    setCandidates(cands);
    setEstimate(est);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const addEntry = async () => {
    const content = newContent.trim();
    if (!content || !window.companion) return;
    await window.companion.memory.upsert({ type: newType, content, priority: 3 });
    setNewContent('');
    await refresh();
  };

  const updateEntry = async (entry: MemoryEntry, patch: Partial<MemoryEntry>) => {
    if (!window.companion) return;
    await window.companion.memory.upsert({
      id: entry.id,
      type: patch.type ?? entry.type,
      content: patch.content ?? entry.content,
      priority: patch.priority ?? entry.priority,
      enabled: patch.enabled ?? entry.enabled
    });
    await refresh();
  };

  const removeEntry = async (id: string) => {
    if (!window.companion) return;
    await window.companion.memory.remove(id);
    await refresh();
  };

  const acceptAll = async () => {
    if (!window.companion) return;
    for (const c of candidates) {
      await window.companion.memory.acceptCandidate(c.id);
    }
    await refresh();
  };

  const openRaw = async () => {
    if (!window.companion) return;
    setRawText(await window.companion.memory.rawGet());
    setRawError(null);
    setRawMode(true);
  };

  const saveRaw = async () => {
    if (!window.companion) return;
    const result = await window.companion.memory.rawSet(rawText);
    if (!result.ok) {
      setRawError(result.error ?? t('memory.rawError'));
      return;
    }
    setRawMode(false);
    await refresh();
  };

  if (rawMode) {
    return (
      <div>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={16}
          spellCheck={false}
          className="w-full rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-2 font-mono text-[11.5px] text-text-primary focus:border-vellum-bronze-light/60 focus:outline-none"
        />
        {rawError && <p className="mt-1.5 text-[11px] text-danger">{rawError}</p>}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void saveRaw()}
            className="flex-1 rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 py-2 text-[12px] font-medium text-vellum-bronze-light hover:bg-vellum-bronze-light/20"
          >
            {t('memory.rawSave')}
          </button>
          <button
            onClick={() => setRawMode(false)}
            className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-[12px] text-text-secondary hover:bg-white/10"
          >
            {t('memory.rawCancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* meret-figyelmeztetes */}
      {estimate && (
        <p
          className={`text-[11px] ${
            estimate.overHardLimit ? 'text-danger' : estimate.warn ? 'text-warning' : 'text-text-secondary/70'
          }`}
        >
          {t('memory.size', { tokens: estimate.tokens })}
          {estimate.overHardLimit && ` — ${t('memory.overLimit')}`}
          {!estimate.overHardLimit && estimate.warn && ` — ${t('memory.nearLimit')}`}
        </p>
      )}

      {/* javaslatok */}
      {candidates.length > 0 && (
        <div className="rounded-lg border border-vellum-teal/30 bg-vellum-teal/5 p-2.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-vellum-teal">
              {t('memory.candidates', { count: candidates.length })}
            </span>
            <button
              onClick={() => void acceptAll()}
              className="rounded-md border border-vellum-teal/40 px-2 py-0.5 text-[10.5px] text-vellum-teal hover:bg-vellum-teal/10"
            >
              {t('memory.acceptAll')}
            </button>
          </div>
          <div className="space-y-1">
            {candidates.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-[12px]">
                <span className="mt-0.5 shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-text-secondary">
                  {c.type}
                </span>
                <span className="min-w-0 flex-1 text-text-primary">{c.content}</span>
                <button
                  onClick={async () => {
                    await window.companion?.memory.acceptCandidate(c.id);
                    await refresh();
                  }}
                  title={t('memory.accept')}
                  className="shrink-0 text-success hover:opacity-70"
                >
                  ✓
                </button>
                <button
                  onClick={async () => {
                    await window.companion?.memory.rejectCandidate(c.id);
                    await refresh();
                  }}
                  title={t('memory.reject')}
                  className="shrink-0 text-danger hover:opacity-70"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* uj bejegyzes */}
      <div className="flex gap-1.5">
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value as MemoryEntryType)}
          className="shrink-0 rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-2 py-2 text-[12px] text-text-primary focus:outline-none"
        >
          {TYPE_ORDER.map((type) => (
            <option key={type} value={type}>
              {t(`memory.type.${type}` as never)}
            </option>
          ))}
        </select>
        <input
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addEntry();
          }}
          placeholder={t('memory.newPlaceholder')}
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-2 text-[12.5px] text-text-primary placeholder:text-text-secondary/40 focus:border-vellum-bronze-light/60 focus:outline-none"
        />
        <button
          onClick={() => void addEntry()}
          disabled={newContent.trim() === ''}
          className="shrink-0 rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 text-[12px] font-medium text-vellum-bronze-light hover:bg-vellum-bronze-light/20 disabled:opacity-30"
        >
          +
        </button>
      </div>

      {/* bejegyzesek tipus szerint csoportositva */}
      {TYPE_ORDER.map((type) => {
        const group = entries.filter((e) => e.type === type);
        if (group.length === 0) return null;
        return (
          <div key={type}>
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-text-secondary/60">
              {t(`memory.type.${type}` as never)}
              <span className="ml-1.5 font-normal normal-case text-text-secondary/40">
                {t(`memory.placement.${type}` as never)}
              </span>
            </p>
            <div className="space-y-1">
              {group.map((entry) => (
                <div
                  key={entry.id}
                  className={`flex items-start gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 ${
                    entry.enabled ? '' : 'opacity-40'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(e) => void updateEntry(entry, { enabled: e.target.checked })}
                    className="mt-1 shrink-0 accent-[rgb(var(--vellum-bronze-light-rgb))]"
                  />
                  <input
                    value={entry.content}
                    onChange={(e) => {
                      setEntries((prev) =>
                        prev.map((x) => (x.id === entry.id ? { ...x, content: e.target.value } : x))
                      );
                    }}
                    onBlur={(e) => void updateEntry(entry, { content: e.target.value })}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-primary focus:outline-none"
                  />
                  <select
                    value={entry.priority}
                    onChange={(e) => void updateEntry(entry, { priority: Number(e.target.value) })}
                    title={t('memory.priority')}
                    className="shrink-0 bg-transparent text-[11px] text-text-secondary focus:outline-none"
                  >
                    {[1, 2, 3, 4, 5].map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void removeEntry(entry.id)}
                    title={t('memory.remove')}
                    className="shrink-0 text-text-secondary hover:text-danger"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {entries.length === 0 && candidates.length === 0 && (
        <p className="py-2 text-[12px] text-text-secondary/60">{t('memory.empty')}</p>
      )}

      <button
        onClick={() => void openRaw()}
        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11.5px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
      >
        {t('memory.rawEdit')}
      </button>
    </div>
  );
}
