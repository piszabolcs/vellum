// ============================================================================
// vellum - tools/datetime.ts (F6)
// ============================================================================
// ido es datum eszkoz.
//
// MIERT ESZKOZ ES NEM A PROMPTBA EGETVE (ahogy a haveromban volt):
//
// 1. a beegetett datummal nem lehet SZAMOLNI. a "hany nap mulva lesz
//    karacsony" vagy "milyen nap volt tegnap" kerdesre a modell tippelt.
//
// 2. ha a datum a system prompt elejen van, es finom felbontasu (ora-perc),
//    akkor MINDEN hivasnal mas a prompt eleje -> eldobjuk a teljes kv-cache-t,
//    es a modell mindent ujraszamol. ez lassusag, ami butasagnak latszik.
//
// eszkozkent viszont a modell akkor kerdezi le, amikor tenyleg kell,
// es a prompt eleje stabil marad.
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';

// ----------------------------------------------------------------------------
// idozona
// ----------------------------------------------------------------------------
// a felhasznalo magyarorszagon van, tehat europe/budapest.
// ezt nem szabad a rendszer alapertelmezettjere bizni, mert egy
// felhoben futo build maskeppen viselkedne.

const TIME_ZONE = 'Europe/Budapest';

const WEEKDAYS_HU = [
  'vasárnap',
  'hétfő',
  'kedd',
  'szerda',
  'csütörtök',
  'péntek',
  'szombat',
];

const MONTHS_HU = [
  'január',
  'február',
  'március',
  'április',
  'május',
  'június',
  'július',
  'augusztus',
  'szeptember',
  'október',
  'november',
  'december',
];

// ----------------------------------------------------------------------------
// segedfuggvenyek
// ----------------------------------------------------------------------------

/**
 * a megadott idozona szerinti datum-reszeket adja vissza.
 *
 * miert igy: a js Date mindig utc-ben tarol, es a helyi ido a futtato gep
 * beallitasatol fugg. az intl api-val viszont explicit megmondhatjuk,
 * melyik idozonat akarjuk.
 */
function getZonedParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  // a het napjat kulon kerjuk le
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
  });

  const weekdayName = weekdayFormatter.format(date);
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    weekday: weekdayMap[weekdayName] ?? 0,
  };
}

/** iso formatumu datum a megadott idozonaban (yyyy-mm-dd) */
function toIsoDate(date: Date): string {
  const p = getZonedParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** ember altal olvashato magyar datum */
function toHungarianDate(date: Date, includeTime = false): string {
  const p = getZonedParts(date);
  const monthName = MONTHS_HU[p.month - 1];
  const weekdayName = WEEKDAYS_HU[p.weekday];

  const base = `${p.year}. ${monthName} ${p.day}., ${weekdayName}`;

  if (!includeTime) return base;

  return `${base} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * bemeneti datum ertelmezese.
 * elfogadja az iso formatumot, a "ma"/"tegnap"/"holnap" szavakat,
 * es a magyaros "2026.08.03" formatumot is.
 */
function parseInputDate(input: string | undefined): Date | null {
  if (!input || input.trim().length === 0) return new Date();

  const text = input.trim().toLowerCase();

  const now = new Date();

  // relativ szavak
  if (['ma', 'today', 'most', 'now'].includes(text)) return now;

  if (['tegnap', 'yesterday'].includes(text)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  if (['holnap', 'tomorrow'].includes(text)) {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  // magyaros pontos formatum: 2026.08.03 vagy 2026. 08. 03.
  const huMatch = text.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?$/);
  if (huMatch) {
    const parsed = new Date(
      Number(huMatch[1]),
      Number(huMatch[2]) - 1,
      Number(huMatch[3]),
      12, // delre tesszuk, hogy az idozona-eltolas ne vigye at masik napra
    );
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // iso vagy barmi mas, amit a js ert
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ----------------------------------------------------------------------------
// muveletek
// ----------------------------------------------------------------------------

type Unit = 'day' | 'week' | 'month' | 'year' | 'hour' | 'minute';

const UNIT_LABELS: Record<Unit, string> = {
  minute: 'perc',
  hour: 'óra',
  day: 'nap',
  week: 'hét',
  month: 'hónap',
  year: 'év',
};

function addToDate(date: Date, amount: number, unit: Unit): Date {
  const result = new Date(date.getTime());

  switch (unit) {
    case 'minute':
      result.setMinutes(result.getMinutes() + amount);
      break;
    case 'hour':
      result.setHours(result.getHours() + amount);
      break;
    case 'day':
      result.setDate(result.getDate() + amount);
      break;
    case 'week':
      result.setDate(result.getDate() + amount * 7);
      break;
    case 'month':
      // a setMonth kezeli a honapvegeket: jan 31 + 1 honap = marc 3
      // ez neha meglepo, de ez a js szabvany viselkedes
      result.setMonth(result.getMonth() + amount);
      break;
    case 'year':
      result.setFullYear(result.getFullYear() + amount);
      break;
  }

  return result;
}

function diffDays(from: Date, to: Date): number {
  // a napok kulonbsegehez a datumokat delre normalizaljuk,
  // kulonben a nyari idoszamitas atallasa elronthatja
  const fromParts = getZonedParts(from);
  const toParts = getZonedParts(to);

  const fromUtc = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const toUtc = Date.UTC(toParts.year, toParts.month - 1, toParts.day);

  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}

// ----------------------------------------------------------------------------
// tool definicio
// ----------------------------------------------------------------------------

const DateTimeArgsSchema = z.object({
  operation: z
    .enum(['now', 'add', 'diff', 'weekday', 'parse'])
    .describe(
      'now = mai dátum és idő; add = hozzáadás; diff = két dátum különbsége; ' +
        'weekday = a hét napja; parse = dátum értelmezése',
    ),
  base: z
    .string()
    .optional()
    .describe('A kiindulási dátum (ISO formátum, vagy "ma"/"tegnap"/"holnap"). Üresen a mai nap.'),
  target: z
    .string()
    .optional()
    .describe('A cél dátum, a diff művelethez.'),
  amount: z
    .number()
    .optional()
    .describe('Mennyit adjunk hozzá (lehet negatív is), az add művelethez.'),
  unit: z
    .enum(['minute', 'hour', 'day', 'week', 'month', 'year'])
    .optional()
    .describe('Milyen egységben, az add művelethez.'),
});

type DateTimeArgs = z.infer<typeof DateTimeArgsSchema>;

export const dateTimeTool: ToolDef<DateTimeArgs> = {
  name: 'get_datetime',
  category: 'time',
  shortDescription: 'mai dátum, dátumszámítás',
  description: [
    'Megadja a pontos mai dátumot és időt, vagy dátumokkal számol.',
    'MINDIG ezt használd, ha a mai dátum kell, vagy ha időszámítás van',
    'a kérdésben. Soha ne tippelj dátumot.',
    'Az időzóna Europe/Budapest.',
    'Műveletek: now (mai nap), add (hozzáadás), diff (különbség),',
    'weekday (a hét napja), parse (dátum értelmezése).',
  ].join(' '),
  schema: DateTimeArgsSchema,
  jsonSchema: zodToJsonSchema(DateTimeArgsSchema, {
    name: 'DateTimeArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 4,
  priority: 95,

  async execute(args: DateTimeArgs, _ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    const baseDate = parseInputDate(args.base);

    if (!baseDate) {
      return {
        ok: false,
        forModel: '',
        errorForModel: `nem sikerült értelmezni a dátumot: "${args.base}"`,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      let forModel: string;

      switch (args.operation) {
        case 'now': {
          const parts = getZonedParts(baseDate);

          forModel = [
            `Mai dátum: ${toHungarianDate(baseDate, true)}`,
            `ISO formátum: ${toIsoDate(baseDate)}`,
            `Időzóna: ${TIME_ZONE}`,
            `Az év ${parts.month}. hónapja, a hónap ${parts.day}. napja.`,
          ].join('\n');
          break;
        }

        case 'weekday': {
          const parts = getZonedParts(baseDate);

          forModel =
            `${toIsoDate(baseDate)} — ${WEEKDAYS_HU[parts.weekday]}` +
            (args.base ? '' : ' (mai nap)');
          break;
        }

        case 'add': {
          if (args.amount === undefined || !args.unit) {
            return {
              ok: false,
              forModel: '',
              errorForModel:
                'az add művelethez kell az amount (mennyiség) és a unit (egység) is',
              durationMs: Date.now() - startedAt,
            };
          }

          const result = addToDate(baseDate, args.amount, args.unit);
          const label = UNIT_LABELS[args.unit];
          const direction = args.amount >= 0 ? 'múlva' : 'ezelőtt';

          forModel = [
            `Kiindulás: ${toHungarianDate(baseDate)}`,
            `${Math.abs(args.amount)} ${label} ${direction}: ${toHungarianDate(result)}`,
            `ISO: ${toIsoDate(result)}`,
          ].join('\n');
          break;
        }

        case 'diff': {
          const targetDate = parseInputDate(args.target);

          if (!targetDate) {
            return {
              ok: false,
              forModel: '',
              errorForModel:
                'a diff művelethez kell a target (cél dátum) is, értelmezhető formában',
              durationMs: Date.now() - startedAt,
            };
          }

          const days = diffDays(baseDate, targetDate);
          const absDays = Math.abs(days);

          const weeks = Math.floor(absDays / 7);
          const remainingDays = absDays % 7;

          const direction = days >= 0 ? 'múlva' : 'ezelőtt';

          const parts: string[] = [
            `${toIsoDate(baseDate)} és ${toIsoDate(targetDate)} között: ${absDays} nap`,
            `Vagyis ${absDays} nap ${direction}.`,
          ];

          if (weeks > 0) {
            parts.push(`Ez ${weeks} hét és ${remainingDays} nap.`);
          }

          forModel = parts.join('\n');
          break;
        }

        case 'parse': {
          const parts = getZonedParts(baseDate);

          forModel = [
            `Értelmezett dátum: ${toHungarianDate(baseDate)}`,
            `ISO: ${toIsoDate(baseDate)}`,
            `A hét napja: ${WEEKDAYS_HU[parts.weekday]}`,
          ].join('\n');
          break;
        }

        default:
          return {
            ok: false,
            forModel: '',
            errorForModel: `ismeretlen művelet: ${String(args.operation)}`,
            durationMs: Date.now() - startedAt,
          };
      }

      return {
        ok: true,
        forModel,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          error instanceof Error ? error.message : 'ismeretlen hiba a dátumszámításban',
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// export a promptbuilder szamara
// ----------------------------------------------------------------------------

/**
 * a mai datum napi felbontasban.
 *
 * ezt a promptbuilder hasznalja, amig a get_datetime eszkoz nincs bekotve.
 * FONTOS: napi felbontas, nem ora-perc, kulonben minden hivasnal
 * eldobjuk a kv-cache-t.
 */
export function todayForPrompt(): string {
  const now = new Date();
  return `A mai dátum: ${toHungarianDate(now)} (${toIsoDate(now)}).`;
}
