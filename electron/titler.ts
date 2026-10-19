// ============================================================================
// vellum - titler.ts (F4)
// ============================================================================
// rovid cimet ad a beszelgeteseknek, hogy az elozmeny-lista olvashato legyen.
//
// a haveromban egyetlen beszelgetes volt, cimre nem volt szukseg. amint tobb
// van, az "elso uzenet elso 40 karaktere" megoldas hasznalhatatlan listat ad
// ("szia", "na figyelj", "es akkor..."), ezert ezt a segedmodell csinalja.
//
// a cimgeneralas SOSEM blokkolja a chatet: a valasz mar keszen van, mire ez
// lefut, es ha elhasal, a lista visszaesik az elso uzenet elejere.
// ============================================================================

import { oneShotSimple } from './ollamaOneShot';
import { ConversationTitleSchema, ConversationTitleJsonSchema } from './schemas';
import { getConversation, getMessages, renameConversation } from './conversations';

export interface TitlerConfig {
  host: string;
  model: string;
  numCtx: number;
  timeoutMs: number;
}

let config: TitlerConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  // a cimadashoz nem kell nagy kontextus: par uzenet eleje eleg
  numCtx: 8192,
  timeoutMs: 20000,
};

export function configureTitler(next: Partial<TitlerConfig>): void {
  config = { ...config, ...next };
}

const SYSTEM = [
  'A feladatod: rovid, beszedes cimet adni egy beszelgetesnek.',
  '',
  'Szabalyok:',
  '- legfeljebb 6 szo, ideberol maradjon 60 karakter alatt',
  '- a beszelgetes NYELVEN irj (ha magyarul beszelgetnek, magyar cim)',
  '- a TEMAT nevezd meg, ne a formajat ("Docker halozati hiba", nem "Kerdes es valasz")',
  '- ne tegyel ideztojelet, pontot vagy emojit a cim vege',
  '- ha a beszelgetes tartalmatlan (koszones, teszt), akkor is adj valamit',
].join('\n');

/** ennyi karaktert viszunk at uzenetenkent -- a tema az elejen eldol */
const PER_MESSAGE_CHARS = 400;
/** ennyi uzenetbol dontunk */
const MAX_MESSAGES = 4;

/**
 * a beszelgetes elejebol keszit egy rovid mintat a modellnek.
 * a hibabuborekokat kihagyjuk: azok nem a temarol szolnak.
 */
function buildSample(conversationId: string): string | null {
  const messages = getMessages(conversationId)
    .filter((m) => !m.isError && (m.role === 'user' || m.role === 'assistant'))
    .slice(0, MAX_MESSAGES);

  if (messages.length === 0) return null;

  return messages
    .map((m) => {
      const who = m.role === 'user' ? 'Felhasznalo' : 'Asszisztens';
      return `${who}: ${m.content.slice(0, PER_MESSAGE_CHARS)}`;
    })
    .join('\n\n');
}

export interface TitleResult {
  ok: boolean;
  title?: string;
  error?: string;
}

/**
 * cimet general es el is menti.
 *
 * `force` nelkul csak akkor fut, ha a beszelgetesnek meg nincs cime -- igy
 * nyugodtan hivhato minden valasz utan, es nem irja felul azt, amit te
 * kezzel neveztel at.
 */
export async function generateTitle(
  conversationId: string,
  force = false,
): Promise<TitleResult> {
  const conversation = getConversation(conversationId);

  if (!conversation) return { ok: false, error: 'nincs ilyen beszélgetés' };
  if (conversation.title && !force) return { ok: true, title: conversation.title };

  const sample = buildSample(conversationId);

  if (!sample) return { ok: false, error: 'még nincs mit összefoglalni' };

  const result = await oneShotSimple(
    {
      host: config.host,
      model: config.model,
      system: SYSTEM,
      user: `A beszélgetés eleje:\n\n${sample}`,
      schema: ConversationTitleJsonSchema,
      numCtx: config.numCtx,
      timeoutMs: config.timeoutMs,
    },
    (value) => ConversationTitleSchema.parse(value),
  );

  if (!result.ok || !result.data) {
    return { ok: false, error: result.error ?? 'a modell nem adott címet' };
  }

  const title = result.data.title.trim();

  if (title.length === 0) return { ok: false, error: 'üres cím' };

  renameConversation(conversationId, title);

  return { ok: true, title };
}
