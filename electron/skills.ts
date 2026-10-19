// ============================================================================
// vellum - skills.ts (F9)
// ============================================================================
// skill-rendszer progressziv feltarassal.
//
// A MINTA: haromszintu betoltes (agent skills szabvany szerint)
//   1. szint - METAADAT (mindig betoltve): csak a nev es a leiras,
//      skillenkent kb. 50-100 token
//   2. szint - AKTIVALAS: ha kell, betoltodik a teljes SKILL.md torzs,
//      tipikusan 500-2000 token
//   3. szint - IGENY SZERINT: a references/ mappa fajljai
//
// A NYERESEG NAGYSAGRENDJE: 132 skill teljes betoltese 50 000 token folott
// lenne -- higitott figyelem, elpazarolt token, egymasba folyo mintazatok.
// progressziv feltarassal ugyanez 6 600-13 200 token.
//
// MIERT EZ A FORMATUM: az agent skills 2025 decembere ota nyilt,
// platformfuggetlen szabvany. ha a vellum ezt hasznalja, a claude code-hoz
// irt skillek VALTOZTATAS NELKUL mukodnek benne, es forditva.
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import type { SkillMeta } from './shared';
import { SKILL_BODY_WARN_TOKENS, SKILL_NAME_PATTERN } from './shared';
import { estimateTokens } from './tokenizer';
import { tr } from './i18n';

// ----------------------------------------------------------------------------
// allapot
// ----------------------------------------------------------------------------

let skillsDir = '';
let catalog: SkillMeta[] = [];
/** a mar betoltott torzsek, hogy ne olvassuk ujra a lemezt */
const bodyCache = new Map<string, string>();

export function initSkills(directory: string): void {
  skillsDir = directory;
  catalog = [];
  bodyCache.clear();
}

export function getSkillsDir(): string {
  return skillsDir;
}

// ----------------------------------------------------------------------------
// yaml frontmatter parse
// ----------------------------------------------------------------------------
// A real YAML parser (js-yaml, JSON schema = no custom types): the hand-written
// one kept the `>-` marker in folded descriptions and dropped continuation
// lines that contained a colon, so the router saw truncated descriptions.

interface ParsedFrontmatter {
  fields: Record<string, string>;
  nested: Record<string, Record<string, string>>;
  body: string;
  error?: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);

  // a fajlnak "---" sorral kell kezdodnie
  if (lines[0]?.trim() !== '---') {
    return { fields: {}, nested: {}, body: content, error: tr('skills.noFrontmatter') };
  }

  // megkeressuk a zaro "---" sort
  let closingIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { fields: {}, nested: {}, body: content, error: tr('skills.unclosed') };
  }

  const body = lines.slice(closingIndex + 1).join('\n').trim();

  let data: unknown;
  try {
    data = yaml.load(lines.slice(1, closingIndex).join('\n'), { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { fields: {}, nested: {}, body, error: tr('skills.invalidYaml', { reason }) };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { fields: {}, nested: {}, body, error: tr('skills.notMap') };
  }

  const fields: Record<string, string> = {};
  const nested: Record<string, Record<string, string>> = {};

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      // e.g. allowed-tools: [Read, Grep]
      fields[key] = value.map((item) => String(item)).join(' ');
    } else if (value !== null && typeof value === 'object') {
      nested[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    } else if (value !== null && value !== undefined) {
      fields[key] = String(value).trim();
    }
  }

  return { fields, nested, body };
}

// ----------------------------------------------------------------------------
// katalogus felepitese
// ----------------------------------------------------------------------------

/**
 * vegigolvassa a skills mappat, es osszeallitja a katalogust.
 *
 * FONTOS: itt csak a frontmattert olvassuk be, a torzset NEM.
 * ez az elso szintje a progressziv feltarasnak.
 */
export async function loadSkillCatalog(
  disabledNames: string[] = [],
): Promise<SkillMeta[]> {
  if (!skillsDir) return [];

  const result: SkillMeta[] = [];

  let entries: string[];

  try {
    entries = await fs.readdir(skillsDir);
  } catch {
    // nincs skills mappa -> letrehozzuk, hogy a felhasznalo lassa, hova tegye
    try {
      await fs.mkdir(skillsDir, { recursive: true });
    } catch {
      // ha ez sem megy, egyszeruen nincs skill
    }
    catalog = [];
    return [];
  }

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);

    try {
      const stat = await fs.stat(skillPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const mdPath = path.join(skillPath, 'SKILL.md');

    let content: string;

    try {
      content = await fs.readFile(mdPath, 'utf-8');
    } catch {
      // nincs SKILL.md a mappaban -> nem skill
      continue;
    }

    const parsed = parseFrontmatter(content);

    // a kotelezo mezok ellenorzese
    const name = parsed.fields.name?.trim() ?? '';
    const description = parsed.fields.description?.trim() ?? '';

    let error: string | undefined = parsed.error;

    if (!error && name.length === 0) error = tr('skills.missingName');
    if (!error && description.length === 0) error = tr('skills.missingDescription');

    // a szabvany szerint a nevnek egyeznie kell a mappa nevevel
    if (!error && name !== entry) error = tr('skills.nameMismatch', { name, folder: entry });
    if (!error && !SKILL_NAME_PATTERN.test(name)) error = tr('skills.badName');
    if (!error && description.length > 1024) error = tr('skills.descriptionTooLong');

    const estimatedTokens = estimateTokens(parsed.body);

    result.push({
      name: name || entry,
      description,
      license: parsed.fields.license,
      compatibility: parsed.fields.compatibility,
      metadata: parsed.nested.metadata,
      allowedTools: parsed.fields['allowed-tools']
        ? parsed.fields['allowed-tools'].split(/\s+/)
        : undefined,
      path: mdPath,
      estimatedTokens,
      enabled: !disabledNames.includes(name || entry) && !error,
      error,
    });
  }

  result.sort((a, b) => a.name.localeCompare(b.name, 'hu'));

  catalog = result;
  bodyCache.clear();

  return result;
}

export function getCatalog(): SkillMeta[] {
  return catalog;
}

export function getSkill(name: string): SkillMeta | undefined {
  return catalog.find((s) => s.name === name);
}

// ----------------------------------------------------------------------------
// katalogus a promptba (1. szint)
// ----------------------------------------------------------------------------

/**
 * a system promptba kerulo rovid katalogus.
 *
 * ez a progressziv feltaras lenyege: skillenkent 50-100 token, nem pedig
 * a teljes torzs. 10 skillnel is 1000 token alatt kell maradni.
 */
export function buildSkillCatalogPrompt(): string {
  const enabled = catalog.filter((s) => s.enabled && !s.error);

  if (enabled.length === 0) return '';

  const lines = ['ELÉRHETŐ SKILLEK:'];

  for (const skill of enabled) {
    // a leirast levagjuk, ha tul hosszu -- a katalogusnak rovidnek kell lennie
    const shortDescription =
      skill.description.length > 200
        ? skill.description.slice(0, 200) + '...'
        : skill.description;

    lines.push(`- ${skill.name}: ${shortDescription}`);
  }

  lines.push(
    'Ha valamelyik releváns a kérdéshez, hívd a `load_skill` eszközt a nevével.',
  );

  return lines.join('\n');
}

/** a router szamara: nev + leiras parok */
export function getSkillsForRouter(): { name: string; description: string }[] {
  return catalog
    .filter((s) => s.enabled && !s.error)
    .map((s) => ({
      name: s.name,
      description:
        s.description.length > 150
          ? s.description.slice(0, 150) + '...'
          : s.description,
    }));
}

// ----------------------------------------------------------------------------
// torzs betoltese (2. szint)
// ----------------------------------------------------------------------------

export interface LoadSkillResult {
  ok: boolean;
  content?: string;
  tokenCount?: number;
  error?: string;
}

/**
 * betolti egy skill teljes torzset.
 *
 * FONTOS KULONBSEG a keresesi talalatokhoz kepest: a skill torzse NEM
 * kerul adatkeretbe. a skill a felhasznalo sajat tudasbazisa, tehat
 * UTASITAS jellegu, nem kulso adat. ez tudatos dontes.
 */
export async function loadSkillBody(name: string): Promise<LoadSkillResult> {
  const skill = getSkill(name);

  if (!skill) {
    const available = catalog
      .filter((s) => s.enabled && !s.error)
      .map((s) => s.name)
      .join(', ');

    return {
      ok: false,
      error: `nincs ilyen skill: "${name}". Elérhető: ${available || 'egy sincs'}`,
    };
  }

  if (skill.error) {
    return { ok: false, error: `a skill hibás: ${skill.error}` };
  }

  if (!skill.enabled) {
    return { ok: false, error: `a(z) "${name}" skill ki van kapcsolva` };
  }

  const cached = bodyCache.get(name);

  if (cached) {
    return { ok: true, content: cached, tokenCount: estimateTokens(cached) };
  }

  try {
    const content = await fs.readFile(skill.path, 'utf-8');
    const parsed = parseFrontmatter(content);

    bodyCache.set(name, parsed.body);

    return {
      ok: true,
      content: parsed.body,
      tokenCount: estimateTokens(parsed.body),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'nem sikerült beolvasni a skillt',
    };
  }
}

// ----------------------------------------------------------------------------
// referencia fajlok (3. szint)
// ----------------------------------------------------------------------------

export async function loadSkillReference(
  skillName: string,
  referenceName: string,
): Promise<LoadSkillResult> {
  const skill = getSkill(skillName);

  if (!skill) {
    return { ok: false, error: `nincs ilyen skill: "${skillName}"` };
  }

  // biztonsag: a referencia nev nem tartalmazhat utvonal-elemet
  if (referenceName.includes('..') || referenceName.includes('/') || referenceName.includes('\\')) {
    return { ok: false, error: 'érvénytelen referencia-név' };
  }

  const skillDir = path.dirname(skill.path);
  const referencePath = path.join(skillDir, 'references', referenceName);

  try {
    const content = await fs.readFile(referencePath, 'utf-8');

    return { ok: true, content, tokenCount: estimateTokens(content) };
  } catch {
    // kilistazzuk, mi van a references mappaban
    try {
      const files = await fs.readdir(path.join(skillDir, 'references'));

      return {
        ok: false,
        error:
          `nincs ilyen referencia: "${referenceName}". ` +
          `Elérhető: ${files.join(', ')}`,
      };
    } catch {
      return {
        ok: false,
        error: `a(z) "${skillName}" skillnek nincs references mappája`,
      };
    }
  }
}

// ----------------------------------------------------------------------------
// figyelmeztetesek a felhasznalonak
// ----------------------------------------------------------------------------

export interface SkillWarning {
  skillName: string;
  severity: 'warning' | 'error';
  message: string;
}

export function getSkillWarnings(): SkillWarning[] {
  const warnings: SkillWarning[] = [];

  for (const skill of catalog) {
    if (skill.error) {
      warnings.push({
        skillName: skill.name,
        severity: 'error',
        message: skill.error,
      });
      continue;
    }

    if (skill.estimatedTokens > SKILL_BODY_WARN_TOKENS) {
      warnings.push({
        skillName: skill.name,
        severity: 'warning',
        message:
          `a skill törzse nagy (${skill.estimatedTokens} token). ` +
          'Egy 8B-s modellnél 250 sor körül a jó cél. ' +
          'A részletes anyagot tedd a references/ mappába.',
      });
    }
  }

  return warnings;
}

/** a katalogus becsult osszmerete tokenben */
export function getCatalogSize(): { tokens: number; skillCount: number } {
  const prompt = buildSkillCatalogPrompt();

  return {
    tokens: estimateTokens(prompt),
    skillCount: catalog.filter((s) => s.enabled && !s.error).length,
  };
}

// ----------------------------------------------------------------------------
// uj skill letrehozasa sablonbol
// ----------------------------------------------------------------------------

const SKILL_TEMPLATE = `---
name: {{NAME}}
description: >-
  Describe what this skill knows AND when the model should use it.
  The "when" matters as much as the "what". Add keywords the model can
  recognise, e.g. Keywords: example, glossary, how do I.
metadata:
  author: {{AUTHOR}}
  version: "1.0"
---

# {{TITLE}}

The content of the skill goes here.

## Tips

- Keep it under 250 lines. Put longer material into the references/ folder.
- Write concrete examples, not generalities.
- If there is an established procedure, write it down step by step.
`;

export async function createSkillFromTemplate(
  name: string,
  author = 'user',
): Promise<{ ok: boolean; path?: string; error?: string }> {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, error: tr('skills.nameRule') };
  }

  const skillDir = path.join(skillsDir, name);
  const mdPath = path.join(skillDir, 'SKILL.md');

  try {
    await fs.access(mdPath);
    return { ok: false, error: tr('skills.exists') };
  } catch {
    // nem letezik, ez a jo eset
  }

  try {
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });

    const content = SKILL_TEMPLATE.replace(/\{\{NAME\}\}/g, name)
      .replace(/\{\{AUTHOR\}\}/g, author)
      .replace(/\{\{TITLE\}\}/g, name.replace(/-/g, ' '));

    await fs.writeFile(mdPath, content, 'utf-8');

    return { ok: true, path: mdPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : tr('skills.createFailed'),
    };
  }
}
