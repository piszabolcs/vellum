import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { SkillMeta } from '../types/bridge';

/**
 * A skillek kezeloje (F9).
 *
 * A skill egy mappa egy SKILL.md fajllal, az Agent Skills nyilt szabvany
 * szerint -- ezert a Claude Code-hoz irt skillek valtoztatas nelkul mukodnek
 * itt is, es forditva.
 *
 * A katalogus (nev + leiras) MINDIG a promptban van, a teljes torzs viszont
 * csak akkor toltodik be, ha a router relevansnak talalja. Ez a progressziv
 * feltaras: 10 skill igy is 1000 token alatt marad.
 */
export default function SkillManager() {
  const t = useT();
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const list = await window.companion?.skills.list();
    if (list) setSkills(list);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const reload = async () => {
    const list = await window.companion?.skills.reload();
    if (list) setSkills(list);
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || !window.companion) return;
    const result = await window.companion.skills.create(name);
    if (!result.ok) {
      setError(result.error ?? t('skills.createError'));
      return;
    }
    setError(null);
    setNewName('');
    await reload();
  };

  return (
    <div className="space-y-2">
      {skills.length === 0 && (
        <p className="text-[12px] text-text-secondary/60">{t('skills.empty')}</p>
      )}

      {skills.map((skill) => (
        <div
          key={skill.name}
          className={`rounded-lg border px-2.5 py-2 ${
            skill.error
              ? 'border-danger/40 bg-danger/5'
              : 'border-white/10 bg-white/5'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12.5px] font-medium text-text-primary">
              {skill.name}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-text-secondary/60">
              {t('skills.tokens', { n: skill.estimatedTokens })}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-text-secondary">
            {skill.description}
          </p>
          {skill.error && <p className="mt-1 text-[11px] text-danger">{skill.error}</p>}
          {!skill.error && skill.estimatedTokens > 2500 && (
            <p className="mt-1 text-[11px] text-warning">{t('skills.tooLarge')}</p>
          )}
        </div>
      ))}

      <div className="flex gap-1.5">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
          placeholder={t('skills.newPlaceholder')}
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-[var(--vellum-input-bg)] px-3 py-2 text-[12.5px] text-text-primary placeholder:text-text-secondary/40 focus:border-vellum-bronze-light/60 focus:outline-none"
        />
        <button
          onClick={() => void create()}
          disabled={newName.trim() === ''}
          className="shrink-0 rounded-lg border border-vellum-bronze-light/40 bg-vellum-bronze-light/10 px-3 text-[12px] font-medium text-vellum-bronze-light hover:bg-vellum-bronze-light/20 disabled:opacity-30"
        >
          +
        </button>
      </div>
      {error && <p className="text-[11px] text-danger">{error}</p>}

      <div className="flex gap-1.5">
        <button
          onClick={() => void reload()}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11.5px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
        >
          {t('skills.reload')}
        </button>
        <button
          onClick={() => void window.companion?.skills.openFolder()}
          className="flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11.5px] text-text-secondary hover:bg-white/10 hover:text-text-primary"
        >
          {t('skills.openFolder')}
        </button>
      </div>
    </div>
  );
}
