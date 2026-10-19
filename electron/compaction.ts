// ============================================================================
// vellum - compaction.ts (F5)
// ============================================================================
// a haromlepcsos kontextus-strategia MASODIK lepcsoje.
//
// FONTOS: ez mar VESZTESEGES. eloszor mindig az offloadot kell kimeriteni
// (artifacts.ts), mert az veszteségmentes. compactiont csak akkor, ha az
// offload utan is tul van telve a kontextus.
//
// MIERT STRUKTURALT es nem szabad szoveges osszefoglalas:
// a szabad szoveges osszefoglalo hajlamos eldobni pont azt, ami kesobb
// kellene: a dontesek indoklasat, a nyitott kerdeseket. a fix szekciok
// kenyszeritik a modellt, hogy ezeket kulon vegiggondolja.
//
// KOLTSEG, amit tudni kell: a compaction kemeny szemantikai tores, ami
// minden korabbi kv-cache prefixet ervenytelenit. ezert nem szabad gyakran
// csinalni -- van benne egy 5 perces zarolas.
// ============================================================================

import type { OllamaMessage, StoredMessage } from './shared';
import { oneShotSimple } from './ollamaOneShot';
import { CompactionSchema, CompactionJsonSchema, type CompactionParsed } from './schemas';
import { setSummary } from './conversations';
import { estimateTokens } from './tokenizer';

// ----------------------------------------------------------------------------
// konfiguracio
// ----------------------------------------------------------------------------

export interface CompactionConfig {
  host: string;
  model: string;
  numCtx: number;
  /** hany friss uzenetet hagyunk erintetlenul. alap: 6 */
  keepRecentMessages: number;
  /** hany szazaleknal induljon. alap: 0.75 */
  threshold: number;
}

let config: CompactionConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 32768,
  keepRecentMessages: 6,
  threshold: 0.75,
};

export function configureCompaction(next: Partial<CompactionConfig>): void {
  config = { ...config, ...next };
}

// ----------------------------------------------------------------------------
// zarolas
// ----------------------------------------------------------------------------
// ugyanabban a beszelgetesben ne fusson le ketszer 5 percen belul.
// a compaction draga (egy teljes modellhivas) es torik tole a cache.

const COOLDOWN_MS = 5 * 60 * 1000;
const lastRunByConversation = new Map<string, number>();

function isInCooldown(conversationId: string): boolean {
  const last = lastRunByConversation.get(conversationId);
  if (last === undefined) return false;
  return Date.now() - last < COOLDOWN_MS;
}

// ----------------------------------------------------------------------------
// osszefoglalo szoveggé alakitasa
// ----------------------------------------------------------------------------

/**
 * a strukturalt osszefoglalobol emberi (es modell szamara olvashato)
 * szoveget csinal, ami a prompt elejere kerul.
 */
export function summaryToText(summary: CompactionParsed): string {
  const parts: string[] = ['[ÖSSZEFOGLALÓ AZ EDDIGIEKRŐL]'];

  parts.push(`Jelenlegi cél: ${summary.current_goal}`);

  if (summary.established_facts.length > 0) {
    parts.push('');
    parts.push('Megállapított tények:');
    parts.push(...summary.established_facts.map((f) => `- ${f}`));
  }

  if (summary.decisions.length > 0) {
    parts.push('');
    parts.push('Eddigi döntések:');
    parts.push(...summary.decisions.map((d) => `- ${d}`));
  }

  if (summary.open_questions.length > 0) {
    parts.push('');
    parts.push('Nyitott kérdések:');
    parts.push(...summary.open_questions.map((q) => `- ${q}`));
  }

  if (summary.user_preferences_this_thread.length > 0) {
    parts.push('');
    parts.push('A felhasználó preferenciái ebben a beszélgetésben:');
    parts.push(...summary.user_preferences_this_thread.map((p) => `- ${p}`));
  }

  if (summary.artifacts_referenced.length > 0) {
    parts.push('');
    parts.push(
      `Hivatkozott artifactok (a read_artifact eszközzel visszakérhetők): ${summary.artifacts_referenced.join(', ')}`,
    );
  }

  parts.push('');
  parts.push(`Következő lépés: ${summary.next_step}`);
  parts.push('[ÖSSZEFOGLALÓ VÉGE]');

  return parts.join('\n');
}

// ----------------------------------------------------------------------------
// fo fuggveny
// ----------------------------------------------------------------------------

export interface CompactionResult {
  ok: boolean;
  /** a promptba illesztheto osszefoglalo szoveg */
  summaryText?: string;
  /** a strukturalt valtozat, ha kell */
  structured?: CompactionParsed;
  /** hanyadik seq-tol kezdve maradjanak meg az uzenetek */
  keepFromSeq?: number;
  /** hany tokent nyertunk vele */
  tokensSaved?: number;
  error?: string;
  skipped?: 'cooldown' | 'too-few-messages';
}

/**
 * osszefoglalja a beszelgetes regebbi reszet.
 *
 * a friss uzenetek (alapbol az utolso 6) ERINTETLENUL maradnak, mert
 * azok adjak a beszelgetes aktualis fonalat.
 */
export async function runCompaction(
  conversationId: string,
  messages: StoredMessage[],
): Promise<CompactionResult> {
  if (isInCooldown(conversationId)) {
    return { ok: false, skipped: 'cooldown' };
  }

  const keepCount = config.keepRecentMessages;

  // ha nincs eleg uzenet, nincs mit osszefoglalni.
  // a +2 azert kell, hogy legalabb ket uzenetet tudjunk tomoriteni.
  if (messages.length < keepCount + 2) {
    return { ok: false, skipped: 'too-few-messages' };
  }

  const toCompact = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  const transcript = toCompact
    .filter((m) => !m.isError && m.role !== 'system')
    .map((m) => {
      const who =
        m.role === 'user'
          ? 'FELHASZNÁLÓ'
          : m.role === 'assistant'
            ? 'ASSZISZTENS'
            : `ESZKÖZ (${m.role})`;

      // a gondolkodast NEM tesszuk bele: az kozbenso, es tobbnyire
      // nem befolyasolta a vegeredmenyt
      return `${who}: ${m.content}`;
    })
    .join('\n\n');

  const system = [
    'Te egy beszélgetés-összefoglaló segéd vagy.',
    'A feladatod: a beszélgetés eddigi részét tömöríteni úgy, hogy a folytatáshoz',
    'minden szükséges információ megmaradjon.',
    '',
    'AMIT MEG KELL TARTANI:',
    '- a jelenlegi célt',
    '- a megállapított tényeket',
    '- a döntéseket ÉS az indoklásukat',
    '- a nyitott kérdéseket',
    '- a felhasználó ebben a szálban kifejezett preferenciáit',
    '',
    'AMIT EL KELL DOBNI:',
    '- a zsákutcákat, amikről kiderült, hogy nem vezettek sehova',
    '- a felülírt utasításokat (csak a legfrissebb érvényes)',
    '- a már megoldott hibákat',
    '- a köztes gondolkodást, ami nem befolyásolta a végeredményt',
    '',
    'Magyarul írj, tömören.',
  ].join('\n');

  const user = [
    'Az alábbi egy beszélgetés eddigi része. Foglald össze a megadott séma szerint.',
    '',
    '---',
    transcript,
    '---',
  ].join('\n');

  const result = await oneShotSimple<CompactionParsed>(
    {
      host: config.host,
      model: config.model,
      system,
      user,
      schema: CompactionJsonSchema,
      numCtx: config.numCtx,
      timeoutMs: 120000,
    },
    (value) => CompactionSchema.parse(value),
  );

  if (!result.ok || !result.data) {
    return {
      ok: false,
      error: result.error ?? 'az összefoglalás nem sikerült',
    };
  }

  lastRunByConversation.set(conversationId, Date.now());

  const summaryText = summaryToText(result.data);

  // elmentjuk a beszelgeteshez is, hogy kesobb visszaolvashato legyen
  setSummary(conversationId, summaryText);

  const originalTokens = toCompact.reduce(
    (sum, m) => sum + (m.tokenCount ?? estimateTokens(m.content)),
    0,
  );
  const summaryTokens = estimateTokens(summaryText);

  return {
    ok: true,
    summaryText,
    structured: result.data,
    keepFromSeq: toKeep[0]?.seq ?? 0,
    tokensSaved: Math.max(0, originalTokens - summaryTokens),
  };
}

// ----------------------------------------------------------------------------
// csendes vagas felismerese
// ----------------------------------------------------------------------------

/**
 * megnezi, hogy az ollama levagta-e a promptot.
 *
 * a haverom kontextus-fallbackje csak explicit hibat lat. de az ollama
 * nem mindig hibazik: ha betelik a num_ctx, egyszeruen levagja az elejet,
 * NEMAN. a felhasznalo ezt ugy eli meg, hogy "hirtelen elhulyult".
 *
 * a trukk: az ollama valasza tartalmazza a valodi prompt_eval_count-ot.
 * ha az erdemben kisebb, mint amit mi becsultunk, akkor vagas tortent.
 */
export function detectSilentTruncation(
  estimatedPromptTokens: number,
  actualPromptTokens: number | undefined,
): { truncated: boolean; lostPercent: number } {
  if (actualPromptTokens === undefined || actualPromptTokens === 0) {
    return { truncated: false, lostPercent: 0 };
  }

  // ha a valos kisebb, mint a becsult, az vagasra utal.
  // a 15%-os kuszob azert kell, mert a becslesunk maga is pontatlan.
  const difference = estimatedPromptTokens - actualPromptTokens;
  const percent = (difference / estimatedPromptTokens) * 100;

  return {
    truncated: percent > 15,
    lostPercent: Math.round(percent),
  };
}

// ----------------------------------------------------------------------------
// beillesztes a promptba
// ----------------------------------------------------------------------------

/**
 * az osszefoglalot a helyes pozicioba teszi: a stabil blokk UTAN,
 * de a beszelgetes-elozmeny ELE.
 *
 * miert oda: a "lost in the middle" jelenseg miatt a modell a kontextus
 * elejere es vegere tett informaciot idezi fel megbizhatoan. az
 * osszefoglalo a legfontosabb sűrített informacio, tehat elore kell.
 */
export function insertSummaryIntoMessages(
  messages: OllamaMessage[],
  summaryText: string,
  afterSystemCount: number,
): OllamaMessage[] {
  if (!summaryText) return messages;

  const result = [...messages];

  result.splice(afterSystemCount, 0, {
    role: 'system',
    content: summaryText,
  });

  return result;
}
