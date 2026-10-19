// ============================================================================
// vellum - tools/skillTools.ts (F9)
// ============================================================================
// skill betoltes: a progressziv feltaras masodik es harmadik szintje.
//
// 1. szint: a katalogus (nev + leiras) mindig a promptban van -- ezt a
//    skills.ts buildSkillCatalogPrompt fuggvenye adja
// 2. szint: EZ AZ ESZKOZ tolti be a teljes SKILL.md torzset
// 3. szint: a references/ mappa fajljai, szinten ezzel az eszkozzel
//
// FONTOS KULONBSEG a keresesi talalatokhoz kepest:
// a skill torzse NEM kerul adatkeretbe. a skill a felhasznalo sajat
// tudasbazisa, tehat UTASITAS jellegu, nem kulso adat. ez tudatos dontes,
// nem feledekenyseg.
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';
import { loadSkillBody, loadSkillReference, getCatalog } from '../skills';

// ----------------------------------------------------------------------------
// betoltes-kovetes egy valaszon belul
// ----------------------------------------------------------------------------
// max 2 skill tolthetok be egy valaszban. folotte a kontextus telik es a
// mintazatok osszefolynak -- pont az ellenkezojet ernenk el annak, amit
// a progressziv feltarassal akartunk.

const loadedInTurn = new Map<string, Set<string>>();

function turnKey(ctx: ToolContext): string {
  return ctx.conversationId ?? 'no-conversation';
}

export function resetSkillLoadTracking(conversationId: string | null): void {
  loadedInTurn.delete(conversationId ?? 'no-conversation');
}

function getLoadedSkills(ctx: ToolContext): Set<string> {
  const key = turnKey(ctx);
  let set = loadedInTurn.get(key);

  if (!set) {
    set = new Set<string>();
    loadedInTurn.set(key, set);
  }

  return set;
}

const MAX_SKILLS_PER_TURN = 2;

// ----------------------------------------------------------------------------
// load_skill
// ----------------------------------------------------------------------------

const LoadSkillArgsSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe('A skill neve a katalógusból.'),
  reference: z
    .string()
    .optional()
    .describe(
      'Ha a skill részletes referenciaanyagára van szükséged, itt add meg ' +
        'a fájl nevét (pl. hibakodok.md). Enélkül a skill fő tartalma jön.',
    ),
});

type LoadSkillArgs = z.infer<typeof LoadSkillArgsSchema>;

export const loadSkillTool: ToolDef<LoadSkillArgs> = {
  name: 'load_skill',
  category: 'skills',
  shortDescription: 'szakterületi tudásanyag betöltése',
  description: [
    'Betölt egy szakterületi tudásanyagot (skillt) a katalógusból.',
    'Akkor használd, ha a kérdés olyan területet érint, amihez van skill.',
    'Egy válaszban legfeljebb 2 skillt tölthetsz be, tehát válassz okosan.',
    'A skill tartalma UTASÍTÁS jellegű: kövesd, amit leír.',
  ].join(' '),
  schema: LoadSkillArgsSchema,
  jsonSchema: zodToJsonSchema(LoadSkillArgsSchema, {
    name: 'LoadSkillArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 2,
  priority: 80,

  async execute(args: LoadSkillArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const loaded = getLoadedSkills(ctx);

    // ugyanaz a skill ketszer nem tolthető be
    const trackingKey = args.reference
      ? `${args.name}::${args.reference}`
      : args.name;

    if (loaded.has(trackingKey)) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          `a(z) "${args.name}" skillt már betöltötted ebben a válaszban. ` +
          'Használd, amit már megkaptál, és válaszolj.',
        durationMs: Date.now() - startedAt,
      };
    }

    if (loaded.size >= MAX_SKILLS_PER_TURN) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          `egy válaszban legfeljebb ${MAX_SKILLS_PER_TURN} skillt tölthetsz be. ` +
          'Válaszolj azzal, amit már betöltöttél.',
        durationMs: Date.now() - startedAt,
      };
    }

    // referencia fajl vagy fo torzs
    const result = args.reference
      ? await loadSkillReference(args.name, args.reference)
      : await loadSkillBody(args.name);

    if (!result.ok || !result.content) {
      return {
        ok: false,
        forModel: '',
        errorForModel: result.error ?? 'nem sikerült betölteni a skillt',
        durationMs: Date.now() - startedAt,
      };
    }

    loaded.add(trackingKey);

    const header = args.reference
      ? `[BETÖLTÖTT SKILL: ${args.name} / ${args.reference}]`
      : `[BETÖLTÖTT SKILL: ${args.name}]`;

    // NINCS adatkeret: a skill utasitas jellegu, nem kulso adat
    return {
      ok: true,
      data: { name: args.name, tokenCount: result.tokenCount },
      forModel: `${header}\n${result.content}`,
      durationMs: Date.now() - startedAt,
    };
  },
};

// ----------------------------------------------------------------------------
// list_skills
// ----------------------------------------------------------------------------
// akkor kell, ha a modell menet kozben jon ra, hogy kellene valami,
// de a katalogus mar kicsuszott a figyelmebol

const ListSkillsArgsSchema = z.object({});

type ListSkillsArgs = z.infer<typeof ListSkillsArgsSchema>;

export const listSkillsTool: ToolDef<ListSkillsArgs> = {
  name: 'list_skills',
  category: 'skills',
  shortDescription: 'az elérhető skillek listája',
  description:
    'Kilistázza az elérhető szakterületi tudásanyagokat. ' +
    'Akkor használd, ha nem emlékszel, milyen skillek vannak.',
  schema: ListSkillsArgsSchema,
  jsonSchema: zodToJsonSchema(ListSkillsArgsSchema, {
    name: 'ListSkillsArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 1,
  priority: 35,

  async execute(_args: ListSkillsArgs, _ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const catalog = getCatalog().filter((s) => s.enabled && !s.error);

    if (catalog.length === 0) {
      return {
        ok: true,
        forModel: 'Nincs telepített skill.',
        durationMs: Date.now() - startedAt,
      };
    }

    const lines = ['Elérhető skillek:'];

    for (const skill of catalog) {
      lines.push(`- ${skill.name}: ${skill.description}`);
    }

    return {
      ok: true,
      forModel: lines.join('\n'),
      durationMs: Date.now() - startedAt,
    };
  },
};
