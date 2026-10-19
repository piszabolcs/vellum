// ============================================================================
// vellum - tools/memoryTools.ts (F4 + F6)
// ============================================================================
// ket eszkoz, ami a memoriahoz es a korabbi beszelgetesekhez fer hozza.
//
// FONTOS KULONBSEG a ketto kozott:
//   - search_memory: a korabbi BESZELGETESEKBEN keres (vektoros archivum,
//     csak olvashato, idobelyeges)
//   - save_memory: a szerkesztheto MEMORIABA javasol uj bejegyzest
//     (memory.json, prioritasos, felulirhato)
//
// a ketto nem helyettesiti egymast:
//   memory.json       = "ki vagyok es mit szeretek"
//   vektoros archivum = "mit beszeltunk eddig"
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';
import { hybridSearch } from '../retrieval';
import { upsertEntry } from '../memory';
import { getConversation } from '../conversations';
import { DATA_FRAMES } from '../shared';

// ----------------------------------------------------------------------------
// search_memory
// ----------------------------------------------------------------------------

const SearchMemoryArgsSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Mit keresel a korábbi beszélgetésekben, természetes nyelven.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Hány találat kell. Alap: 5.'),
});

type SearchMemoryArgs = z.infer<typeof SearchMemoryArgsSchema>;

export const searchMemoryTool: ToolDef<SearchMemoryArgs> = {
  name: 'search_memory',
  category: 'memory',
  shortDescription: 'keresés a korábbi beszélgetésekben',
  description: [
    'Korábbi beszélgetésekben keres, jelentés és kulcsszó alapján is.',
    'Akkor használd, ha a felhasználó egy korábbi témára, döntésre vagy',
    'megbeszélésre utal ("amiről múltkor beszéltünk", "mit is találtunk ki"),',
    'vagy ha olyat kérdez, amiről már beszéltetek.',
    'NE használd általános tudáskérdésre.',
  ].join(' '),
  schema: SearchMemoryArgsSchema,
  jsonSchema: zodToJsonSchema(SearchMemoryArgsSchema, {
    name: 'SearchMemoryArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 3,
  priority: 85,

  async execute(args: SearchMemoryArgs, _ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    try {
      const hits = await hybridSearch(args.query, {
        limit: args.limit ?? 5,
        sourceTypes: ['message'],
      });

      if (hits.length === 0) {
        return {
          ok: true,
          forModel:
            'Nem találtam korábbi beszélgetést erről a témáról. ' +
            'Válaszolj a saját tudásodból, és jelezd, hogy nincs korábbi előzmény.',
          durationMs: Date.now() - startedAt,
        };
      }

      // a talalatokat beszelgetes szerint cimkezzuk, hogy a modell lassa,
      // mikor es milyen kontextusban hangzott el
      const blocks = hits.map((hit) => {
        const date = new Date(hit.createdAt).toISOString().slice(0, 10);

        let title = 'névtelen beszélgetés';

        if (hit.conversationId) {
          // a beszelgetes lekerdezese lehet, hogy elbukik (torolve lett),
          // de attol meg a chunk szovege ertekes
          try {
            const conversation = getConversation(hit.conversationId);
            if (conversation?.title) title = conversation.title;
          } catch {
            // maradunk az alapertelmezett cimnel
          }
        }

        return `[${date}, "${title}"]\n${hit.text}`;
      });

      // adatkeretbe csomagolva: ezek ADATOK egy korabbi beszelgetesbol,
      // nem utasitasok
      const forModel = [
        DATA_FRAMES.pastConversations.open,
        blocks.join('\n\n'),
        DATA_FRAMES.pastConversations.close,
      ].join('\n');

      return {
        ok: true,
        data: { hitCount: hits.length },
        forModel,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          error instanceof Error
            ? `a keresés hibába ütközött: ${error.message}`
            : 'a keresés nem sikerült',
        durationMs: Date.now() - startedAt,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// save_memory
// ----------------------------------------------------------------------------

const SaveMemoryArgsSchema = z.object({
  type: z
    .enum(['fact', 'style', 'project', 'person', 'preference'])
    .describe(
      'fact = tény a felhasználóról; person = tény másvalakiről; ' +
        'project = aktuális projekt; preference = ízlés, hajlam; ' +
        'style = kemény formai utasítás',
    ),
  content: z
    .string()
    .min(5)
    .max(200)
    .describe('A megjegyzendő információ, egy tömör mondatban.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Mennyire vagy biztos benne, 0 és 1 között.'),
});

type SaveMemoryArgs = z.infer<typeof SaveMemoryArgsSchema>;

export const saveMemoryTool: ToolDef<SaveMemoryArgs> = {
  name: 'save_memory',
  category: 'memory',
  shortDescription: 'új emlék javaslása',
  description: [
    'Javasol egy új memóriabejegyzést a felhasználóról.',
    'FONTOS: ez NEM ír közvetlenül a memóriába, csak javaslatot tesz,',
    'amit a felhasználónak jóvá kell hagynia.',
    'Akkor használd, ha a felhasználó olyat mond magáról, ami később is',
    'hasznos lesz (munka, preferencia, projekt, stílus-elvárás).',
    'NE használd átmeneti dolgokra ("most fáradt vagyok"), és ne arra,',
    'ami csak a beszélgetés tárgya volt.',
  ].join(' '),
  schema: SaveMemoryArgsSchema,
  jsonSchema: zodToJsonSchema(SaveMemoryArgsSchema, {
    name: 'SaveMemoryArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  // Destruktiv: a memoria tartalma minden kesobbi uzenetnel szo szerinti
  // utasitaskent megy a modellnek, tehat egy rossz bejegyzes tartosan elrontja
  // a viselkedest. Ezert a guard eloszor megkerdezi a felhasznalot.
  //
  // MIERT NEM JAVASLAT: a javaslat-sor (candidates) is jovahagyast var, csak
  // kesobb, a Beallitasokban. Ha ide is kerne meg egy megerositest, ugyanazt a
  // tenyt ketszer kellene jovahagyni. Igy a megerosites VALTJA a javaslat-sort:
  // amit itt jovahagysz, az azonnal bejegyzes lesz. A javaslat-sor tovabbra is
  // a hatterben tanulo memoryLearner-e marad.
  destructive: true,
  needsNetwork: false,
  maxCallsPerTurn: 3,
  priority: 60,

  async execute(args: SaveMemoryArgs, _ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    try {
      // ide csak jovahagyott hivas jut el (destructive: true)
      await upsertEntry({
        type: args.type,
        content: args.content,
        confidence: args.confidence,
        // a modell tanulta; a jovahagyast az fejezi ki, hogy bejegyzes lett
        // belole es nem javaslat
        source: 'learned',
      });

      return {
        ok: true,
        forModel:
          'Elmentettem a memóriába, a felhasználó jóváhagyásával. ' +
          'Ezt egy rövid mondatban jelezd is neki.',
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        forModel: '',
        errorForModel:
          error instanceof Error
            ? `nem sikerült elmenteni: ${error.message}`
            : 'nem sikerült elmenteni a javaslatot',
        durationMs: Date.now() - startedAt,
      };
    }
  },
};
