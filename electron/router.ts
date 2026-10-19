// ============================================================================
// vellum - router.ts (F7)
// ============================================================================
// elozetes dontes: milyen utat jarjon be a keres.
//
// a haveromban minden kerdes ugyanazt az utat jarta be. egy "szia" ugyanazt
// a gepezetet inditotta el, mint egy osszetett kutatasi feladat.
//
// az agent-oldali megfogalmazas pont a mi helyzetunkre illik: egyetlen
// forduloban van egy olcso szandek-osztalyozas, egy kozepes eszkozvalasztas,
// egy draga tobblepéses gondolatmenet es egy kozepes valaszszintezis --
// es az optimalis strategia mindegyik lepest KULON iranyitja.
//
// A LEGNAGYOBB KOCKAZAT: a csendes minosegromlas. ha a router rosszul
// osztalyoz, a felhasznalo csak rossz valaszt lat, es nem derul ki, hogy a
// dontes volt a hibas. ezert KOTELEZO:
//   1. minden dontes naplozva (router_log tabla)
//   2. a felhasznalo latja, mit dontott
//   3. kezzel felulbiralhato
// ============================================================================

import type {
  RouterDecision,
  AppLanguage,
  OllamaMessage,
} from './shared';
import { safeFallbackDecision } from './shared';
import { oneShotSimple } from './ollamaOneShot';
import {
  RouterDecisionSchema,
  RouterDecisionJsonSchema,
  type RouterDecisionParsed,
} from './schemas';
import { getDb } from './db';

// ----------------------------------------------------------------------------
// konfiguracio
// ----------------------------------------------------------------------------

export interface RouterConfig {
  host: string;
  /** a segedmodell. ha ures, a fo modell */
  model: string;
  numCtx: number;
  timeoutMs: number;
  language: AppLanguage;
  /** generaljon-e angol keresokifejezest is */
  englishSearchQueries: boolean;
  /** engedelyezett-e a nagy modell */
  largeModelEnabled: boolean;
}

let config: RouterConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 8192,
  timeoutMs: 15000,
  language: 'hu',
  englishSearchQueries: true,
  largeModelEnabled: false,
};

export function configureRouter(next: Partial<RouterConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// a router promptja
// ----------------------------------------------------------------------------

function buildSystemPrompt(
  availableCategories: string[],
  availableSkills: { name: string; description: string }[],
): string {
  const lines = [
    'Te egy útválasztó vagy egy helyi AI asszisztensben.',
    'A feladatod NEM az, hogy válaszolj a kérdésre.',
    'A feladatod eldönteni, milyen erőforrások kellenek a válaszhoz.',
    '',
    'SZÁNDÉK (intent) kategóriák:',
    '- chitchat: köszönés, udvariaskodás, semmi érdemi. Nem kell semmi.',
    '- factual: időtlen ténykérdés (pl. "mi a fotoszintézis"). Nem kell keresés.',
    '- timely: időben változó tény (ár, verzió, hír, időjárás, "legújabb").',
    '  ILYENKOR A KERESÉS KÖTELEZŐ.',
    '- reasoning: gondolkodást, levezetést igénylő feladat.',
    '- code: kódolás, hibakeresés, technikai megvalósítás.',
    '- personal: a felhasználóról vagy korábbi beszélgetésről szól.',
    '- task: több lépéses feladat, ami eszközöket igényel.',
    '- meta: magáról az alkalmazásról kérdez.',
    '',
    `ESZKÖZ-KATEGÓRIÁK, amiket választhatsz: ${availableCategories.join(', ')}`,
    'Csak azt válaszd, ami tényleg kell. Kevesebb jobb, mint több.',
  ];

  if (availableSkills.length > 0) {
    lines.push('');
    lines.push('ELÉRHETŐ SKILLEK (legfeljebb 2-t válassz):');
    for (const skill of availableSkills) {
      lines.push(`- ${skill.name}: ${skill.description}`);
    }
  }

  lines.push(
    '',
    'GONDOLKODÁS (thinking):',
    '- off: egyszerű kérdés, nem kell gondolkodni (köszönés, egyszerű tény)',
    '- short: átlagos kérdés',
    '- long: összetett levezetés, matek, kód, több lépéses tervezés',
    '',
    'MODELL (model_tier):',
    config.largeModelEnabled
      ? '- small: a legtöbb esetben. large: csak nagyon összetett feladatnál.'
      : '- MINDIG "small". A nagy modell ki van kapcsolva.',
    '',
    'KERESŐKIFEJEZÉSEK:',
    'Ha needs_web igaz, adj meg 1-2 magyar keresőkifejezést.',
  );

  if (config.englishSearchQueries) {
    lines.push(
      'ÉS adj meg 1-2 ANGOL keresőkifejezést is, mert az angol nyelvű',
      'műszaki tartalom a neten nagyságrendekkel bővebb.',
      'Ne szó szerint fordíts: azt írd, ahogy egy angol anyanyelvű keresné.',
    );
  } else {
    lines.push('Az angol keresőkifejezéseket hagyd üresen.');
  }

  lines.push(
    '',
    'Ha needs_web hamis, mindkét keresőkifejezés-lista legyen üres.',
  );

  return lines.join('\n');
}

function buildUserPrompt(
  currentMessage: string,
  recentHistory: OllamaMessage[],
): string {
  const parts: string[] = [];

  if (recentHistory.length > 0) {
    parts.push('A beszélgetés utolsó néhány üzenete (kontextusnak):');
    parts.push('---');

    for (const message of recentHistory) {
      const who = message.role === 'user' ? 'Felhasználó' : 'Asszisztens';
      // levagjuk, mert a routernek nem kell a teljes szoveg
      const excerpt =
        message.content.length > 300
          ? message.content.slice(0, 300) + '...'
          : message.content;

      parts.push(`${who}: ${excerpt}`);
    }

    parts.push('---');
    parts.push('');
  }

  parts.push('A mostani kérdés, amiről döntened kell:');
  parts.push(`"${currentMessage}"`);

  return parts.join('\n');
}

// ----------------------------------------------------------------------------
// utofeldolgozas
// ----------------------------------------------------------------------------

/**
 * a modell dontese neha ellentmondasos. ezeket csendben javitjuk.
 *
 * miert nem kuldjuk vissza javitasra: a router gyorsasagatol fugg, hogy
 * megeri-e egyaltalan. egy masodik kor elvinne az elonyt.
 */
function normalizeDecision(
  raw: RouterDecisionParsed,
  availableCategories: string[],
  availableSkillNames: string[],
): RouterDecision {
  const decision: RouterDecision = { ...raw };

  // ha nem kell web, ne legyenek keresokifejezesek
  if (!decision.needs_web) {
    decision.search_queries_hu = [];
    decision.search_queries_en = [];
  }

  // ha kell web, de nem adott kifejezest, az hiba -- ilyenkor a
  // hivo fel majd a nyers kerdessel keres
  if (decision.needs_web && decision.search_queries_hu.length === 0) {
    decision.search_queries_hu = [];
  }

  // ha az angol kereses ki van kapcsolva, uritjuk
  if (!config.englishSearchQueries) {
    decision.search_queries_en = [];
  }

  // ha kell web, a search kategoria kotelezo
  if (decision.needs_web && !decision.tool_categories.includes('search')) {
    decision.tool_categories.push('search');
  }

  // ha kell memoria-kereses, a memory kategoria kotelezo
  if (
    decision.needs_memory_search &&
    !decision.tool_categories.includes('memory')
  ) {
    decision.tool_categories.push('memory');
  }

  // csak letezo kategoriakat engedunk at
  decision.tool_categories = decision.tool_categories.filter((c) =>
    availableCategories.includes(c),
  );

  // csak letezo skilleket engedunk at
  decision.skills = decision.skills.filter((s) => availableSkillNames.includes(s));

  // ha a nagy modell ki van kapcsolva, mindig small
  if (!config.largeModelEnabled) {
    decision.model_tier = 'small';
  }

  // a chitchat sosem igenyel gondolkodast vagy eszkozt
  if (decision.intent === 'chitchat') {
    decision.thinking = 'off';
    decision.needs_web = false;
    decision.needs_memory_search = false;
    decision.tool_categories = [];
    decision.skills = [];
    decision.search_queries_hu = [];
    decision.search_queries_en = [];
  }

  return decision;
}

// ----------------------------------------------------------------------------
// fo fuggveny
// ----------------------------------------------------------------------------

export interface RouteOptions {
  currentMessage: string;
  /** az utolso nehany uzenet kontextusnak. max 3. */
  recentHistory?: OllamaMessage[];
  availableCategories: string[];
  availableSkills?: { name: string; description: string }[];
  conversationId?: string | null;
  messageId?: string | null;
  /** a felhasznalo kezi felulbiralasai */
  overrides?: {
    forceWeb?: boolean;
    forceThorough?: boolean;
    forceLargeModel?: boolean;
  };
}

export interface RouteResult {
  decision: RouterDecision;
  /** honnan jott a dontes */
  source: 'model' | 'fallback' | 'override';
  durationMs: number;
  error?: string;
}

/**
 * lefuttatja a routert.
 *
 * SOHA nem dob kivetelt es soha nem blokkol vegtelenul.
 * ha barmi baj van, a biztonsagos fallback lep eletbe, ami nagyjabol
 * a haverom mai viselkedese: nem kenyszerit semmit, de mindent megenged.
 */
export async function route(options: RouteOptions): Promise<RouteResult> {
  const startedAt = Date.now();

  const skills = options.availableSkills ?? [];
  const skillNames = skills.map((s) => s.name);

  const system = buildSystemPrompt(options.availableCategories, skills);
  const user = buildUserPrompt(
    options.currentMessage,
    (options.recentHistory ?? []).slice(-3),
  );

  const result = await oneShotSimple<RouterDecisionParsed>(
    {
      host: config.host,
      model: config.model,
      system,
      user,
      schema: RouterDecisionJsonSchema,
      numCtx: config.numCtx,
      timeoutMs: config.timeoutMs,
      think: false,
    },
    (value) => RouterDecisionSchema.parse(value),
  );

  let decision: RouterDecision;
  let source: RouteResult['source'];

  if (result.ok && result.data) {
    decision = normalizeDecision(
      result.data,
      options.availableCategories,
      skillNames,
    );
    source = 'model';
  } else {
    decision = safeFallbackDecision(config.language);
    source = 'fallback';
  }

  // a kezi felulbiralas MINDIG nyer
  if (options.overrides) {
    let overridden = false;

    if (options.overrides.forceWeb) {
      decision.needs_web = true;
      if (!decision.tool_categories.includes('search')) {
        decision.tool_categories.push('search');
      }
      overridden = true;
    }

    if (options.overrides.forceThorough) {
      decision.thinking = 'long';
      overridden = true;
    }

    if (options.overrides.forceLargeModel && config.largeModelEnabled) {
      decision.model_tier = 'large';
      overridden = true;
    }

    if (overridden) source = 'override';
  }

  const durationMs = Date.now() - startedAt;

  // naplozas: ez ved a csendes minosegromlas ellen
  logDecision(
    options.conversationId ?? null,
    options.messageId ?? null,
    decision,
    durationMs,
  );

  return {
    decision,
    source,
    durationMs,
    error: result.ok ? undefined : result.error,
  };
}

// ----------------------------------------------------------------------------
// naplozas
// ----------------------------------------------------------------------------

function logDecision(
  conversationId: string | null,
  messageId: string | null,
  decision: RouterDecision,
  durationMs: number,
): void {
  try {
    const db = getDb();

    db.prepare(
      `INSERT INTO router_log
         (conversation_id, message_id, decision_json, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      conversationId,
      messageId,
      JSON.stringify(decision),
      durationMs,
      Date.now(),
    );
  } catch {
    // ha az adatbazis nem elerheto, a naplozas hianya ne allitsa meg a valaszt
  }
}

export interface RouterLogEntry {
  id: number;
  conversationId: string | null;
  messageId: string | null;
  decision: RouterDecision;
  durationMs: number;
  createdAt: number;
}

export function getRouterLog(limit = 50): RouterLogEntry[] {
  try {
    const db = getDb();

    const rows = db
      .prepare(
        `SELECT * FROM router_log ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      conversation_id: string | null;
      message_id: string | null;
      decision_json: string;
      duration_ms: number;
      created_at: number;
    }[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      decision: JSON.parse(row.decision_json) as RouterDecision,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------------------------
// emberi osszefoglalo a felhasznalonak
// ----------------------------------------------------------------------------

const INTENT_LABELS: Record<RouterDecision['intent'], string> = {
  chitchat: 'csevegés',
  factual: 'ténykérdés',
  timely: 'friss információ',
  reasoning: 'gondolkodás',
  code: 'kódolás',
  personal: 'személyes',
  task: 'feladat',
  meta: 'az appról',
};

const THINKING_LABELS: Record<RouterDecision['thinking'], string> = {
  off: 'nincs gondolkodás',
  short: 'rövid gondolkodás',
  long: 'alapos gondolkodás',
};

/**
 * rovid, ember szamara olvashato osszefoglalo a dontesrol.
 * ez jelenik meg a valasz alatt osszecsukott sorban.
 */
export function describeDecision(decision: RouterDecision): string {
  const parts: string[] = [INTENT_LABELS[decision.intent]];

  if (decision.needs_web) parts.push('keresés');
  if (decision.needs_memory_search) parts.push('emlékezet');
  if (decision.skills.length > 0) parts.push(`skill: ${decision.skills.join(', ')}`);

  parts.push(THINKING_LABELS[decision.thinking]);

  if (decision.model_tier === 'large') parts.push('nagy modell');

  return parts.join(' · ');
}

// ----------------------------------------------------------------------------
// segedfuggveny: mely eszkozok kotelezoek
// ----------------------------------------------------------------------------

/**
 * a router dontesebol kiszedi, mely eszkozoket KELL meghivni.
 *
 * ez a guard requiredToolsPending mezojebe kerul, es ez ved a
 * "lepeskihagyas" hibamod ellen: a modell nem valaszolhat magabiztosan
 * egy idoben valtozo tenyre kereses nelkul.
 */
export function requiredToolsFrom(decision: RouterDecision): string[] {
  const required: string[] = [];

  if (decision.needs_web) required.push('web_search');
  if (decision.needs_memory_search) required.push('search_memory');

  return required;
}

/**
 * osszerakja a keresokifejezeseket egy listaba.
 * a magyar es angol valtozat egyutt megy a keresobe, es a talalatokat
 * rrf-fel fesuljuk ossze -- onnantol a nyelv nem szamit.
 */
export function allSearchQueries(
  decision: RouterDecision,
  fallbackQuery: string,
): string[] {
  const queries = [...decision.search_queries_hu, ...decision.search_queries_en]
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  // ha a router nem adott kifejezest, a nyers kerdessel keresunk
  if (queries.length === 0) return [fallbackQuery];

  return queries;
}
