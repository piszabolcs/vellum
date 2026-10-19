// ============================================================================
// vellum - schemas/index.ts
// ============================================================================
// itt van minden json schema egy helyen.
//
// FONTOS SZABALY: LAPOS SEMAK.
// a melyen egymasba agyazott vagy rekurziv semak rontjak a kimenet minoseget
// a grammar-kenyszeritett dekodolasnal. maximum egy szint tomb primitivekbol.
// ha osszetettebb kell, bontsd ket hivasra.
//
// minden sema exportalja:
//   - a zod objektumot (validalashoz)
//   - a belole generalt json schema-t (az ollama format parameterehez)
//   - a tipust
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ----------------------------------------------------------------------------
// segedfuggveny
// ----------------------------------------------------------------------------

/**
 * zod semabol json schema-t csinal, az ollama szamara emesztheto formaban.
 *
 * a $schema es a definitions kulcsokat kiszedjuk, mert az ollama nem
 * mindig kezeli oket jol, es csak feleslegesen bonyolitjak a grammart.
 */
function toJsonSchema(schema: z.ZodType<unknown>, name: string): Record<string, unknown> {
  const generated = zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none', // ne legyen $ref, minden legyen kifejtve
  }) as Record<string, unknown>;

  // a zodToJsonSchema a definitions ala teszi a semat, ha nevet adunk neki.
  // nekunk a sema maga kell, kicsomagolva.
  const definitions = generated.definitions as
    | Record<string, Record<string, unknown>>
    | undefined;

  if (definitions && definitions[name]) {
    return definitions[name];
  }

  delete generated.$schema;
  return generated;
}

// ============================================================================
// 1. ROUTER (F7)
// ============================================================================
// a router elore eldonti, milyen utat jarjon be a keres.
// ez a legfontosabb sema, mert ez vezerli az egesz valaszadasi folyamatot.

export const RouterDecisionSchema = z.object({
  intent: z.enum([
    'chitchat',
    'factual',
    'timely',
    'reasoning',
    'code',
    'personal',
    'task',
    'meta',
  ]),
  needs_web: z.boolean(),
  needs_memory_search: z.boolean(),
  tool_categories: z.array(z.string()).max(3),
  skills: z.array(z.string()).max(2),
  complexity: z.enum(['low', 'medium', 'high']),
  thinking: z.enum(['off', 'short', 'long']),
  model_tier: z.enum(['small', 'large']),
  language: z.enum(['hu', 'en']),
  // ket nyelvu keresokifejezes: az angol muszaki tartalom a neten
  // nagysagrendekkel bovebb, mint a magyar
  search_queries_hu: z.array(z.string()).max(2),
  search_queries_en: z.array(z.string()).max(2),
});

export type RouterDecisionParsed = z.infer<typeof RouterDecisionSchema>;
export const RouterDecisionJsonSchema = toJsonSchema(
  RouterDecisionSchema,
  'RouterDecision',
);

// ============================================================================
// 2. MEMORIA-TANULAS (F3)
// ============================================================================
// a beszelgetes vegen kiszedi az uj, megjegyzesre erdemes tenyeket.
// FONTOS: ezek nem kerulnek automatikusan a memoriaba, csak javaslatok
// lesznek beloluk, amiket a felhasznalonak jova kell hagynia.

export const MemoryCandidatesSchema = z.object({
  candidates: z
    .array(
      z.object({
        type: z.enum(['fact', 'style', 'project', 'person', 'preference']),
        content: z.string().max(200),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(5),
});

export type MemoryCandidatesParsed = z.infer<typeof MemoryCandidatesSchema>;
export const MemoryCandidatesJsonSchema = toJsonSchema(
  MemoryCandidatesSchema,
  'MemoryCandidates',
);

// ============================================================================
// 3. MEMORIA-MIGRACIO (F3)
// ============================================================================
// a regi, szabad szoveges memory.md-t alakitja tipizalt bejegyzesekke.
// egyszer fut le, a haveromrol valo atallaskor.

export const MemoryMigrationSchema = z.object({
  entries: z
    .array(
      z.object({
        type: z.enum(['fact', 'style', 'project', 'person', 'preference']),
        content: z.string().max(300),
        priority: z.number().int().min(1).max(5),
      }),
    )
    .max(30),
});

export type MemoryMigrationParsed = z.infer<typeof MemoryMigrationSchema>;
export const MemoryMigrationJsonSchema = toJsonSchema(
  MemoryMigrationSchema,
  'MemoryMigration',
);

// ============================================================================
// 4. COMPACTION (F5)
// ============================================================================
// a beszelgetes osszefoglalasa, ha megtelik a kontextus.
//
// miert fix szekciok es nem szabad szoveg: a strukturalt osszefoglalo
// sokkal jobban tartja a folytonossagot. a szabad szoveges hajlamos
// eldobni pont azt, ami kesobb kellene (dontesek, indoklas).

export const CompactionSchema = z.object({
  current_goal: z.string().max(300),
  established_facts: z.array(z.string()).max(10),
  decisions: z.array(z.string()).max(8),
  open_questions: z.array(z.string()).max(5),
  user_preferences_this_thread: z.array(z.string()).max(5),
  next_step: z.string().max(300),
  artifacts_referenced: z.array(z.string()).max(10),
});

export type CompactionParsed = z.infer<typeof CompactionSchema>;
export const CompactionJsonSchema = toJsonSchema(CompactionSchema, 'Compaction');

// ============================================================================
// 5. ARTIFACT OSSZEFOGLALO (F5)
// ============================================================================
// egy nagy tool-kimenetbol csinal rovid osszefoglalot, ami a kontextusba megy.
// a teljes tartalom lemezen marad, es a read_artifact eszkozzel kerheto vissza.

export const ArtifactSummarySchema = z.object({
  summary: z.string().max(400),
  key_points: z.array(z.string()).max(5),
});

export type ArtifactSummaryParsed = z.infer<typeof ArtifactSummarySchema>;
export const ArtifactSummaryJsonSchema = toJsonSchema(
  ArtifactSummarySchema,
  'ArtifactSummary',
);

// ============================================================================
// 6. RERANK PONTOZAS (F8)
// ============================================================================
// a jeloltek ujrarangsorolasa. a bi-encoder (embedding) kulon kodolja a
// kerdest es a dokumentumot, sosem latjak egymast. itt viszont egyutt
// pontozzuk oket, ami sokkal pontosabb sorrendet ad.

export const RerankScoresSchema = z.object({
  scores: z
    .array(
      z.object({
        index: z.number().int().min(0),
        score: z.number().min(0).max(10),
      }),
    )
    .max(20),
});

export type RerankScoresParsed = z.infer<typeof RerankScoresSchema>;
export const RerankScoresJsonSchema = toJsonSchema(RerankScoresSchema, 'RerankScores');

// ============================================================================
// 7. GROUNDING ELLENORZES (F8)
// ============================================================================
// megnezi, hogy a valasz allitasait alatamasztjak-e a behuzott forrasok.
//
// FONTOS: ez CSAK ellenorzes, nem javitas. a kulso megalapozas nelkuli
// onjavitas ("gondold at megegyszer") merten RONTJA a teljesitmenyt.
// az ellenorzes viszont mukodik, mert osztalyozni egyszerubb, mint generalni.

export const GroundingCheckSchema = z.object({
  all_claims_supported: z.boolean(),
  unsupported_claims: z.array(z.string()).max(3),
});

export type GroundingCheckParsed = z.infer<typeof GroundingCheckSchema>;
export const GroundingCheckJsonSchema = toJsonSchema(
  GroundingCheckSchema,
  'GroundingCheck',
);

// ============================================================================
// 8. HYDE (F8)
// ============================================================================
// hipotetikus dokumentum generalasa keresteshez.
//
// KEMENY KORLAT: a generalt szoveg NEM VALOS es tartalmazhat hamis
// reszleteket. kizarolag keresesre hasznalhato, bizonyitekkent SOHA.
// ez a szoveg soha nem kerulhet a valasz kontextusaba.

export const HydeSchema = z.object({
  hypothetical_document: z.string().max(800),
});

export type HydeParsed = z.infer<typeof HydeSchema>;
export const HydeJsonSchema = toJsonSchema(HydeSchema, 'Hyde');

// ============================================================================
// 9. BESZELGETES CIM (F4)
// ============================================================================

export const ConversationTitleSchema = z.object({
  title: z.string().max(60),
});

export type ConversationTitleParsed = z.infer<typeof ConversationTitleSchema>;
export const ConversationTitleJsonSchema = toJsonSchema(
  ConversationTitleSchema,
  'ConversationTitle',
);

// ============================================================================
// 10. EVAL JUDGE (F2)
// ============================================================================
// az eval harness hasznalja a minoseg ertekelesehez.
//
// a judge SOHA nem kapja meg a vart valaszt, csak a kriteriumot,
// a kerdest es a tenyleges valaszt.

export const JudgeVerdictSchema = z.object({
  verdict: z.enum(['pass', 'partial', 'fail']),
  score: z.number().min(0).max(5),
  reason: z.string().max(300),
});

export type JudgeVerdictParsed = z.infer<typeof JudgeVerdictSchema>;
export const JudgeVerdictJsonSchema = toJsonSchema(JudgeVerdictSchema, 'JudgeVerdict');

// ============================================================================
// 10b. VALASZTAS TOBB VALASZ KOZUL (F11 - self-consistency)
// ============================================================================
// FONTOS a kulonbseg: ez KIVALASZTAS tobb, egymastol fuggetlenul generalt
// valasz kozul -- nem onreflexio. A "gondold at megegyszer" tipusu onjavitas
// kulso megalapozas nelkul merten RONT, ezert azt nem csinaljuk.

export const BestAnswerSchema = z.object({
  /** a valasztott valasz sorszama, 1-tol */
  choice: z.number().int().min(1),
  reason: z.string().max(200),
});

export type BestAnswerParsed = z.infer<typeof BestAnswerSchema>;
export const BestAnswerJsonSchema = toJsonSchema(BestAnswerSchema, 'BestAnswer');

// ============================================================================
// 11. TESZT SEMA (F1)
// ============================================================================
// a scripts/check-structured-output.ts hasznalja annak ellenorzesere,
// hogy a beallitott modell egyaltalan tartja-e a semat.

export const SmokeTestSchema = z.object({
  city: z.string(),
  country: z.string(),
  population_millions: z.number(),
});

export type SmokeTestParsed = z.infer<typeof SmokeTestSchema>;
export const SmokeTestJsonSchema = toJsonSchema(SmokeTestSchema, 'SmokeTest');
