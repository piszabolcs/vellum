// ============================================================================
// vellum - selfConsistency.ts (F11)
// ============================================================================
// Nehez kerdesnel tobb valaszt generaltatunk, es a legjobbat valasztjuk ki.
//
// MIERT MUKODIK: egy nyelvi modell mintavetelezessel dolgozik, tehat ugyanarra
// a kerdesre tobb kulonbozo gondolatmenetet adhat. Ha tobb fuggetlen futas
// ugyanoda jut, az jelzes ertekű; ha szetszorodnak, az is.
//
// AMI TILOS, es amit ez NEM csinal: megkerdezni a modellt, hogy "biztos vagy
// benne?" vagy "gondold at megegyszer". Az onreflexio kulso megalapozas nelkul
// merten ront a valasz minosegen -- a modell hajlamos a helyes valaszt is
// visszavonni, ha ketelkedni latszik tole a kerdes. Itt EGYMASTOL FUGGETLEN
// valaszok kozul valasztunk, ami mas muvelet.
//
// ARA: K-szoros ido. Ezert alapból ki van kapcsolva, es csak akkor indul, ha a
// router "reasoning"-nek itelte a kerdest.
// ============================================================================

import { oneShotSimple } from './ollamaOneShot';
import { BestAnswerSchema, BestAnswerJsonSchema } from './schemas';

export interface SelfConsistencyConfig {
  host: string;
  model: string;
  numCtx: number;
  timeoutMs: number;
}

let config: SelfConsistencyConfig = {
  host: 'http://localhost:11434',
  model: 'qwen3:30b-a3b-q4_K_M',
  numCtx: 8192,
  timeoutMs: 30000,
};

export function configureSelfConsistency(next: Partial<SelfConsistencyConfig>): void {
  config = { ...config, ...next };
}

const SYSTEM = [
  'Tobb, egymastol fuggetlenul keszult valasz kozul kell kivalasztanod a legjobbat.',
  '',
  'Szempontok, ebben a sorrendben:',
  '1. tenybeli helyesseg -- ha ket valasz ellentmond, melyiket tamasztja ala tobb reszlet',
  '2. teljesseg -- valaszol-e a feltett kerdesre, nem csak egy reszere',
  '3. kovetkezetesseg -- nincs-e onellentmondas a valaszon belul',
  '',
  'NE a hosszabbat valaszd automatikusan, es ne a magabiztosabb hangneműt.',
  'Csak a sorszamot add vissza es egy rovid indoklast.',
].join('\n');

/** ennyi karaktert adunk at valaszonkent a valasztonak */
const PER_ANSWER_CHARS = 3000;

export interface PickResult {
  index: number;
  reason: string | null;
  /** false, ha a valasztas nem sikerult es az elso valaszra estunk vissza */
  chosen: boolean;
}

/**
 * Kivalasztja a legjobb valaszt. Hiba eseten az elsore esik vissza -- ez a
 * korabbi (self-consistency nelkuli) viselkedes, tehat rosszabb nem lehet tole.
 */
export async function pickBestAnswer(answers: string[]): Promise<PickResult> {
  if (answers.length === 0) return { index: 0, reason: null, chosen: false };
  if (answers.length === 1) return { index: 0, reason: null, chosen: false };

  const listed = answers
    .map((answer, i) => `### ${i + 1}. válasz\n${answer.slice(0, PER_ANSWER_CHARS)}`)
    .join('\n\n');

  try {
    const result = await oneShotSimple(
      {
        host: config.host,
        model: config.model,
        system: SYSTEM,
        user: listed,
        schema: BestAnswerJsonSchema,
        numCtx: config.numCtx,
        timeoutMs: config.timeoutMs,
      },
      (value) => BestAnswerSchema.parse(value),
    );

    if (!result.ok || !result.data) return { index: 0, reason: null, chosen: false };

    // a modell 1-tol szamoz; ha ervenytelen szamot ad, az elso valasz marad
    const index = result.data.choice - 1;

    if (index < 0 || index >= answers.length) {
      return { index: 0, reason: null, chosen: false };
    }

    return { index, reason: result.data.reason, chosen: true };
  } catch {
    return { index: 0, reason: null, chosen: false };
  }
}
