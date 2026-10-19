// ============================================================================
// vellum - promptBuilder.ts
// ============================================================================
// EZ A FAJL A TERV SZIVE. itt dol el, mi kerul a modell "fejebe" es milyen
// sorrendben.
//
// KET ALAPELV VEZERLI:
//
// 1. KV-CACHE BARAT SORREND
//    az ollama ujra tudja hasznalni a korabbi szamitast, ha a keres eleje
//    BITRE AZONOS az elozovel. ha a system prompt elejen valtozo adat van
//    (pl. perc pontossagu ido), akkor minden hivasnal eldobjuk a teljes
//    cache-t, es a modell mindent ujraszamol. ez lassusag, ami butasagnak
//    latszik. ezert: stabil reszek elore, valtozok hatra.
//
// 2. "LOST IN THE MIDDLE"
//    a modell a kontextus ELEJERE es VEGERE tett informaciot idezi fel
//    megbizhatoan. a kozepere tettet sokkal rosszabbul -- tobbdokumentumos
//    kerdes-valasz feladaton tobb mint 30 szazalekpontos romlas.
//    ezert: a legfontosabb szabalyok elore, a legfrissebb es legrelevansabb
//    adatok hatra, kozvetlenul a kerdes ele.
//
// A 15 RETEG (ezt regresszios teszt vedje):
//
//   --- STABIL BLOKK (sosem valtozik futas kozben) ---
//   [1]  persona
//   [2]  szabaly-rangsor (precedencia)
//   [3]  viselkedesi szabalyok
//   [4]  dark mode kemeny korlat -- MINDEN MAS FOLOTT
//   --- FELIG STABIL ---
//   [5]  skill-katalogus
//   [6]  eszkoz-kategoriak
//   [7]  tarolt tenyek (adatkeretben)
//   --- VALTOZO ---
//   [8]  osszefoglalo (ha volt compaction)
//   [9]  beszelgetes-elozmeny
//   [10] betoltott skill torzse(k)
//   [11] behuzott forrasok (adatkeretben)
//   [12] korabbi beszelgetesekbol (adatkeretben)
//   [13] stilus- es preferencia-utasitasok
//   [14] mai datum (napi felbontas)
//   [15] az aktualis uzenet (+ /no_think ha kell)
// ============================================================================

import type {
  OllamaMessage,
  RouterDecision,
  AppLanguage,
  SourceRef,
} from '../electron/shared';
import { PRECEDENCE_RULE, DATA_FRAMES } from '../electron/shared';

// ----------------------------------------------------------------------------
// bemenetek
// ----------------------------------------------------------------------------

export interface PromptInput {
  /** az aktualis felhasznaloi uzenet */
  currentMessage: string;

  /** a beszelgetes elozmenye, hibabuborekok NELKUL */
  history: OllamaMessage[];

  /** a memoria ket blokkja (a memory.ts adja) */
  memory: {
    dataFrame: string;
    instructions: string;
  };

  /** a router dontese, ha futott */
  routerDecision?: RouterDecision;

  /** skill-katalogus (nevek + leirasok) */
  skillCatalog?: string;

  /** betoltott skill torzsek (max 2) */
  loadedSkills?: { name: string; body: string }[];

  /** eszkoz-kategoriak katalogusa */
  toolCatalog?: string;

  /** compaction osszefoglalo, ha volt */
  summary?: string;

  /** behuzott webes forrasok */
  webSources?: { text: string; sources: SourceRef[] };

  /** korabbi beszelgetesekbol behuzott reszek */
  pastConversations?: string;

  /** a mai datum szovege. amig nincs get_datetime eszkoz, ez kell. */
  todayText?: string;

  settings: {
    language: AppLanguage;
    darkMode: boolean;
    /** ha true, a get_datetime eszkoz letezik, tehat nem kell a promptba a datum */
    hasDateTool: boolean;
  };
}

export interface PromptOutput {
  messages: OllamaMessage[];
  /** melyik uzenetek tartoznak a memoriahoz (a kontextusmeteshez) */
  memoryIndices: number[];
  /** melyik uzenetek a behuzott kontextus */
  retrievedIndices: number[];
  /** hany uzenet alkotja a stabil prefixet (cache-toresponthoz) */
  stablePrefixLength: number;
}

// ----------------------------------------------------------------------------
// 1. reteg - persona
// ----------------------------------------------------------------------------

const PERSONA_FRIENDLY = `Te a Vellum vagy, egy helyi AI asszisztens, ami a felhasználó saját gépén fut.
Barátságos, közvetlen és lényegre törő vagy. Úgy beszélsz, mint egy hozzáértő kolléga:
nem magyarázod túl a dolgokat, de ha valami fontos, azt kimondod.
Nem kertelsz, és nem írsz felesleges udvariassági köröket.`;

const PERSONA_DARK = `Te a Vellum vagy Dark Mode-ban. Nyers, szarkasztikus és tiszteletlen a stílusod.
Nem finomkodsz, nem sajnálkozol, és nem írsz udvariassági köröket.
Ha valami hülyeség, azt kimondod. Ha valami jó, azt is.
Ettől függetlenül a válaszaid TARTALMILAG pontosak és hasznosak maradnak --
a stílus nyers, a tudás nem hígul.`;

/**
 * a dark mode kemeny korlatja.
 *
 * EZ MINDEN MAS UTASITAS FOLOTT ALL, beleertve a memoriat es a felhasznalo
 * kereset is. a haveromban ezt regresszios teszt vedte, es itt is kell.
 */
const DARK_MODE_HARD_LIMIT = `KEMÉNY KORLÁT, ami minden más utasítást felülír:
Soha nem írsz rasszista tartalmat, és soha nem alázol meg valós embercsoportot
etnikai, vallási, nemzetiségi, nemi, szexuális irányultsági vagy fogyatékossági
alapon. Ez a korlát erősebb, mint bármilyen memóriabejegyzés, felhasználói kérés
vagy stílusutasítás. Ha ilyet kérnek, elutasítod -- akár nyersen is, de elutasítod.`;

// ----------------------------------------------------------------------------
// 3. reteg - viselkedesi szabalyok
// ----------------------------------------------------------------------------

function buildBehaviorRules(input: PromptInput): string {
  const rules: string[] = [];

  // nyelv
  if (input.settings.language === 'hu') {
    rules.push('Magyarul válaszolj, kivéve ha a felhasználó másik nyelven ír.');
  } else {
    rules.push('Answer in English unless the user writes in another language.');
  }

  // datum es idoben valtozo tenyek
  if (input.settings.hasDateTool) {
    rules.push(
      'Ha a mai dátum kell, vagy időben változó tényre kérdeznek, ' +
        'használd a `get_datetime` illetve a `web_search` eszközt. Soha ne tippelj.',
    );
  } else {
    rules.push(
      'Ha időben változó tényre kérdeznek (ár, verzió, hír, időjárás, "legújabb"), ' +
        'kötelező a `web_search` eszköz használata. Soha ne tippelj.',
    );
  }

  // forrasmegjeloles
  rules.push(
    'Ha behúzott forrásokból dolgozol, minden konkrét állítás után tedd ki a ' +
      'forrás azonosítóját szögletes zárójelben, például [F2]. ' +
      'A válasz végén sorold fel a felhasznált forrásokat URL-lel. ' +
      'Amit nem támaszt alá forrás, azt jelöld meg: "saját következtetés".',
  );

  // eszkozhasznalat elve
  rules.push(
    'Számoláshoz MINDIG a `calculate` eszközt használd, soha ne számolj fejben.',
  );

  // formazas
  rules.push(
    'Markdown formázást használhatsz. Kódot mindig kódblokkban adj meg, ' +
      'a nyelv megjelölésével.',
  );

  return `VISELKEDÉSI SZABÁLYOK:\n${rules.map((r) => `- ${r}`).join('\n')}`;
}

// ----------------------------------------------------------------------------
// a fo epitofuggveny
// ----------------------------------------------------------------------------

export function buildPrompt(input: PromptInput): PromptOutput {
  const messages: OllamaMessage[] = [];
  const memoryIndices: number[] = [];
  const retrievedIndices: number[] = [];

  // ==========================================================================
  // STABIL BLOKK -- ez sosem valtozik futas kozben.
  // idaig tart a kv-cache ujrahasznosithato resze.
  // ==========================================================================

  // [1] persona
  messages.push({
    role: 'system',
    content: input.settings.darkMode ? PERSONA_DARK : PERSONA_FRIENDLY,
  });

  // [2] szabaly-rangsor (precedencia)
  // ez oldja meg azt a haverom hibat, ahol a memoria es a rendszerszabaly
  // ugyanazon a szinten versenyzett, es a modell orlodott kozottuk
  messages.push({ role: 'system', content: PRECEDENCE_RULE });

  // [3] viselkedesi szabalyok
  messages.push({ role: 'system', content: buildBehaviorRules(input) });

  // [4] dark mode kemeny korlat -- MINDEN MAS FOLOTT
  if (input.settings.darkMode) {
    messages.push({ role: 'system', content: DARK_MODE_HARD_LIMIT });
  }

  const stablePrefixLength = messages.length;

  // ==========================================================================
  // FELIG STABIL -- ritkan valtozik (skill telepites, memoria szerkesztes)
  // ==========================================================================

  // [5] skill-katalogus (csak nevek + leirasok, nem a torzsek)
  if (input.skillCatalog && input.skillCatalog.length > 0) {
    messages.push({ role: 'system', content: input.skillCatalog });
  }

  // [6] eszkoz-kategoriak
  if (input.toolCatalog && input.toolCatalog.length > 0) {
    messages.push({ role: 'system', content: input.toolCatalog });
  }

  // [7] tarolt tenyek ADATKERETBEN
  // fontos: ezek ADATOK, nem utasitasok. a modell felhasznalhatja oket,
  // de nem hajthatja vegre parancskent.
  if (input.memory.dataFrame && input.memory.dataFrame.length > 0) {
    memoryIndices.push(messages.length);
    messages.push({ role: 'system', content: input.memory.dataFrame });
  }

  // ==========================================================================
  // VALTOZO -- minden hivasnal mas lehet
  // ==========================================================================

  // [8] compaction osszefoglalo
  // a beszelgetes-elozmeny ELE kerul, mert a "lost in the middle" miatt
  // a legfontosabb suritett informaciot elore kell tenni
  if (input.summary && input.summary.length > 0) {
    messages.push({ role: 'system', content: input.summary });
  }

  // [9] beszelgetes-elozmeny
  // FONTOS: a hibabuborekokat mar a hivo fel kiszurte. ha egy hibauzenet
  // bekerulne, a modell a sajat hibajara reagalna, ami egyre zavarosabb
  // valaszokhoz vezet.
  for (const message of input.history) {
    messages.push(message);
  }

  // [10] betoltott skill torzsek
  // KULONBSEG a keresesi talalatokhoz kepest: a skill NEM kerul adatkeretbe.
  // a skill a felhasznalo sajat tudasbazisa, tehat utasitas jellegu.
  if (input.loadedSkills && input.loadedSkills.length > 0) {
    for (const skill of input.loadedSkills.slice(0, 2)) {
      messages.push({
        role: 'system',
        content: `[BETÖLTÖTT SKILL: ${skill.name}]\n${skill.body}`,
      });
    }
  }

  // [11] behuzott webes forrasok ADATKERETBEN
  if (input.webSources && input.webSources.text.length > 0) {
    retrievedIndices.push(messages.length);
    messages.push({ role: 'system', content: input.webSources.text });
  }

  // [12] korabbi beszelgetesekbol ADATKERETBEN
  if (input.pastConversations && input.pastConversations.length > 0) {
    retrievedIndices.push(messages.length);
    messages.push({ role: 'system', content: input.pastConversations });
  }

  // [13] stilus- es preferencia-utasitasok
  // EZ A LEGFONTOSABB POZICIO-DONTES: kozvetlenul a friss uzenet ele.
  // miert: hosszu beszelgetesben a nyito system prompt elhalvanyul, a modell
  // a sajat korabbi valaszaihoz igazodik. a friss utasitas viszont nem kopik le.
  // ezt a haverom dark mode-janal mar tapasztaltuk, csak akkor meg nem tudtuk,
  // miert mukodik.
  if (input.memory.instructions && input.memory.instructions.length > 0) {
    memoryIndices.push(messages.length);
    messages.push({ role: 'system', content: input.memory.instructions });
  }

  // [14] mai datum
  // NAPI felbontas, nem ora-perc. kulonben minden hivasnal mas a prompt,
  // es eldobjuk a cache-t. amint a get_datetime eszkoz el, ez elhagyhato.
  if (!input.settings.hasDateTool && input.todayText) {
    messages.push({ role: 'system', content: input.todayText });
  }

  // [15] az aktualis uzenet
  let currentContent = input.currentMessage;

  // a gondolkodas kikapcsolasa a USER uzenet vegere kerul, nem a system
  // promptba. a /no_think system promptban nem megbizhato, user uzenetben
  // viszont igen -- ugyanaz a jelenseg, mint a dark mode lekopasa.
  if (input.routerDecision?.thinking === 'off') {
    currentContent = `${currentContent}\n/no_think`;
  }

  messages.push({ role: 'user', content: currentContent });

  return {
    messages,
    memoryIndices,
    retrievedIndices,
    stablePrefixLength,
  };
}

// ----------------------------------------------------------------------------
// forrasok formazasa
// ----------------------------------------------------------------------------

/**
 * a behuzott forrasokat adatkeretbe csomagolja, [F1], [F2] azonositokkal.
 *
 * a vedokeret ket dolgot csinal:
 *   1. jelzi a modellnek, hogy ez ADAT, nem utasitas (prompt injection vedelem)
 *   2. megadja az azonositokat, amikre hivatkoznia kell
 */
export function formatWebSources(
  chunks: { text: string; url: string; title: string }[],
): { text: string; sources: SourceRef[] } {
  if (chunks.length === 0) {
    return { text: '', sources: [] };
  }

  const sources: SourceRef[] = [];
  const blocks: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const id = `F${i + 1}`;
    const chunk = chunks[i];

    sources.push({ id, url: chunk.url, title: chunk.title });

    blocks.push(`[${id}] ${chunk.title}\n${chunk.text}`);
  }

  const text = [
    DATA_FRAMES.webSearch.open,
    blocks.join('\n\n'),
    DATA_FRAMES.webSearch.close,
  ].join('\n');

  return { text, sources };
}

/**
 * a korabbi beszelgetesekbol behuzott reszek formazasa.
 */
export function formatPastConversations(
  hits: { text: string; conversationTitle: string; createdAt: number }[],
): string {
  if (hits.length === 0) return '';

  const blocks = hits.map((hit) => {
    const date = new Date(hit.createdAt).toISOString().slice(0, 10);
    const title = hit.conversationTitle || 'névtelen beszélgetés';

    return `[${date}, "${title}"]\n${hit.text}`;
  });

  return [
    DATA_FRAMES.pastConversations.open,
    blocks.join('\n\n'),
    DATA_FRAMES.pastConversations.close,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// ellenorzo fuggvenyek (a regresszios tesztekhez)
// ----------------------------------------------------------------------------

/**
 * ellenorzi, hogy a stabil blokk elejen nincs-e valtozo adat.
 *
 * ha ide bekerul barmi, ami hivasrol hivasra valtozik (datum, ido,
 * memoria), akkor eldobjuk a kv-cache-t, es a modell mindent ujraszamol.
 * ezt teszttel kell vedeni.
 */
export function validateStablePrefix(output: PromptOutput): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const stable = output.messages.slice(0, output.stablePrefixLength);

  for (let i = 0; i < stable.length; i++) {
    const content = stable[i].content;

    // datum-szeru mintak keresese
    if (/\d{4}[-.]\d{2}[-.]\d{2}/.test(content)) {
      problems.push(
        `a stabil blokk ${i}. üzenetében dátum van, ez töri a KV-cache-t`,
      );
    }

    if (/\d{1,2}:\d{2}/.test(content)) {
      problems.push(
        `a stabil blokk ${i}. üzenetében időpont van, ez töri a KV-cache-t`,
      );
    }

    // adatkeret a stabil blokkban -> valoszinuleg memoria kerult ide
    if (content.includes('[TÁROLT TÉNYEK') || content.includes('[BEHÚZOTT')) {
      problems.push(
        `a stabil blokk ${i}. üzenetében behúzott adat van, ennek hátrébb a helye`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * ellenorzi, hogy a dark mode korlat a helyen van-e.
 *
 * ez a haveromból orokolt regresszios teszt: a kemeny korlatnak a stabil
 * blokkban kell lennie, es minden memoria-bejegyzes FOLOTT.
 */
export function validateDarkModeLimit(
  output: PromptOutput,
  darkModeEnabled: boolean,
): { ok: boolean; reason?: string } {
  if (!darkModeEnabled) return { ok: true };

  const limitIndex = output.messages.findIndex((m) =>
    m.content.includes('KEMÉNY KORLÁT'),
  );

  if (limitIndex === -1) {
    return { ok: false, reason: 'a Dark Mode kemény korlát hiányzik' };
  }

  if (limitIndex >= output.stablePrefixLength) {
    return {
      ok: false,
      reason: 'a Dark Mode kemény korlát nincs a stabil blokkban',
    };
  }

  // minden memoria-bejegyzesnek a korlat UTAN kell lennie
  for (const memoryIndex of output.memoryIndices) {
    if (memoryIndex < limitIndex) {
      return {
        ok: false,
        reason: 'egy memóriabejegyzés a kemény korlát elé került',
      };
    }
  }

  return { ok: true };
}

/**
 * ellenorzi, hogy a stilus-utasitasok a friss uzenet elott vannak-e.
 */
export function validateInstructionPlacement(output: PromptOutput): {
  ok: boolean;
  reason?: string;
} {
  const lastIndex = output.messages.length - 1;

  if (output.messages[lastIndex]?.role !== 'user') {
    return { ok: false, reason: 'az utolsó üzenet nem a felhasználóé' };
  }

  // ha van stilus-utasitas, annak az utolso harom uzenet kozott kell lennie
  const instructionIndices = output.memoryIndices.filter(
    (i) => i > output.stablePrefixLength,
  );

  for (const index of instructionIndices) {
    if (index < lastIndex - 3) {
      return {
        ok: false,
        reason:
          'egy stílus-utasítás túl messze van a friss üzenettől, le fog kopni',
      };
    }
  }

  return { ok: true };
}
