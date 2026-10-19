// ============================================================================
// vellum - tools/artifactTools.ts (F5 + F6)
// ============================================================================
// a felretett nagy tartalmak visszakerese.
//
// ez a parja az artifacts.ts offload mechanizmusanak. amikor egy tool-kimenet
// tul nagy volt, lemezre kerult, es a kontextusba csak egy osszefoglalo ment.
// ezzel az eszkozzel a modell visszakerheti, ha tobbet akar tudni.
//
// FONTOS: ha a modell megad egy query-t, akkor NEM a teljes szoveget kapja
// vissza, hanem a relevans reszt. kulonben a visszaolvasas ugyanugy megtoltene
// a kontextust, mint az eredeti tartalom -- es akkor semmit nem nyertunk volna.
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';
import { readArtifact, listArtifacts } from '../artifacts';
import { DATA_FRAMES, frameAsData } from '../shared';

// ----------------------------------------------------------------------------
// read_artifact
// ----------------------------------------------------------------------------

const ReadArtifactArgsSchema = z.object({
  id: z
    .string()
    .min(3)
    .max(50)
    .describe('Az artifact azonosítója, amit korábban megkaptál (pl. art_a1b2c3d4).'),
  query: z
    .string()
    .optional()
    .describe(
      'Mit keresel benne. Ha megadod, csak a releváns rész jön vissza, ' +
        'nem a teljes tartalom. Nagy artifactoknál MINDIG add meg.',
    ),
});

type ReadArtifactArgs = z.infer<typeof ReadArtifactArgsSchema>;

export const readArtifactTool: ToolDef<ReadArtifactArgs> = {
  name: 'read_artifact',
  category: 'artifacts',
  shortDescription: 'korábban félretett tartalom visszakérése',
  description: [
    'Visszaadja egy korábban félretett nagy tartalom teljes szövegét vagy',
    'annak releváns részét.',
    'Akkor használd, ha egy korábbi keresés vagy fájlolvasás összefoglalója',
    'nem volt elég, és a részletekre is szükséged van.',
    'Nagy tartalomnál MINDIG adj meg query paramétert is, hogy csak a',
    'lényeg jöjjön vissza.',
  ].join(' '),
  schema: ReadArtifactArgsSchema,
  jsonSchema: zodToJsonSchema(ReadArtifactArgsSchema, {
    name: 'ReadArtifactArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 3,
  priority: 75,

  async execute(args: ReadArtifactArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    const result = await readArtifact(args.id, args.query);

    if (!result.ok) {
      // ha nincs ilyen artifact, felsoroljuk, mi van -- igy a modell
      // tud javitani a kovetkezo korben
      let hint = '';

      if (ctx.conversationId) {
        try {
          const available = listArtifacts(ctx.conversationId);

          if (available.length > 0) {
            const ids = available.slice(0, 5).map((a) => a.id).join(', ');
            hint = ` Elérhető azonosítók ebben a beszélgetésben: ${ids}`;
          }
        } catch {
          // ha a listazas elbukik, marad a sima hibauzenet
        }
      }

      return {
        ok: false,
        forModel: '',
        errorForModel: `${result.error ?? 'nem sikerült beolvasni'}.${hint}`,
        durationMs: Date.now() - startedAt,
      };
    }

    const header = args.query
      ? `[Artifact ${args.id} — részlet a "${args.query}" keresésre]`
      : `[Artifact ${args.id} — teljes tartalom]`;

    return {
      ok: true,
      forModel: frameAsData(DATA_FRAMES.storedContent, `${header}\n${result.text}`),
      durationMs: Date.now() - startedAt,
    };
  },
};

// ----------------------------------------------------------------------------
// list_artifacts
// ----------------------------------------------------------------------------

const ListArtifactsArgsSchema = z.object({});

type ListArtifactsArgs = z.infer<typeof ListArtifactsArgsSchema>;

export const listArtifactsTool: ToolDef<ListArtifactsArgs> = {
  name: 'list_artifacts',
  category: 'artifacts',
  shortDescription: 'a félretett tartalmak listája',
  description:
    'Kilistázza, milyen tartalmakat tettünk félre ebben a beszélgetésben. ' +
    'Akkor használd, ha nem emlékszel egy artifact azonosítójára.',
  schema: ListArtifactsArgsSchema,
  jsonSchema: zodToJsonSchema(ListArtifactsArgsSchema, {
    name: 'ListArtifactsArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 1,
  priority: 40,

  async execute(_args: ListArtifactsArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    if (!ctx.conversationId) {
      return {
        ok: true,
        forModel: 'Ebben a beszélgetésben még nincs félretett tartalom.',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const artifacts = listArtifacts(ctx.conversationId);

      if (artifacts.length === 0) {
        return {
          ok: true,
          forModel: 'Ebben a beszélgetésben még nincs félretett tartalom.',
          durationMs: Date.now() - startedAt,
        };
      }

      const lines = ['Félretett tartalmak ebben a beszélgetésben:'];

      for (const artifact of artifacts) {
        const kb = (artifact.bytes / 1024).toFixed(0);
        const title = artifact.title ?? artifact.kind;

        lines.push(`- ${artifact.id}: ${title} (${kb} KB)`);
      }

      return {
        ok: true,
        forModel: lines.join('\n'),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          error instanceof Error ? error.message : 'nem sikerült listázni',
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
