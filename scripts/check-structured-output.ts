// ============================================================================
// vellum - scripts/check-structured-output.ts (F1)
// ============================================================================
// KOTELEZO ELLENORZO SZKRIPT az F1 fazis lezarasa elott.
//
// MIT ELLENORIZ: hogy a beallitott modell tartja-e a json semat
//   a) think: true mellett
//   b) think: false mellett
//
// MIERT FONTOS: egyes gondolkodasra kepes modelleknel a thinking
// kikapcsolasa CSENDBEN eldobhatja a format kenyszert. ha ez a te
// modelleddel is igy van, akkor a segedhivasoknal (router, memoria,
// compaction) bent kell hagyni a thinket -- lassabb lesz, de mukodik.
//
// FUTTATAS:
//   npx tsx scripts/check-structured-output.ts
//   npx tsx scripts/check-structured-output.ts --model qwen3:8b
// ============================================================================

import { ollamaOneShot } from '../electron/ollamaOneShot';
import { SmokeTestSchema, SmokeTestJsonSchema } from '../electron/schemas';

// ----------------------------------------------------------------------------
// parameterek
// ----------------------------------------------------------------------------

function getArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);

  if (index !== -1 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return fallback;
}

const HOST = getArg('host', 'http://localhost:11434');
const MODEL = getArg('model', 'qwen3:8b');
const NUM_CTX = Number(getArg('ctx', '8192'));
const ROUNDS = Number(getArg('rounds', '3'));

// ----------------------------------------------------------------------------
// teszt eset
// ----------------------------------------------------------------------------

const SYSTEM = 'Te egy adatszolgáltató segéd vagy. Tömören válaszolj.';
const USER = 'Adj adatokat Budapestről: a város neve, az ország, és a lakosság millióban.';

interface RoundResult {
  ok: boolean;
  durationMs: number;
  attempts: number;
  error?: string;
  data?: unknown;
}

async function runRound(think: boolean): Promise<RoundResult> {
  const result = await ollamaOneShot(
    {
      host: HOST,
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
      schema: SmokeTestJsonSchema,
      numCtx: NUM_CTX,
      temperature: 0,
      think,
      timeoutMs: 120000,
      // itt SZANDEKOSAN kikapcsoljuk az ujraprobalkozast, mert azt
      // akarjuk merni, hogy ELSORE tartja-e a semat
      allowRetry: false,
    },
    (value) => SmokeTestSchema.parse(value),
  );

  return {
    ok: result.ok,
    durationMs: result.durationMs,
    attempts: result.attempts,
    error: result.error,
    data: result.data,
  };
}

// ----------------------------------------------------------------------------
// futtatas
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(70));
  console.log('Vellum — strukturált kimenet ellenőrzés');
  console.log('='.repeat(70));
  console.log(`Host:     ${HOST}`);
  console.log(`Modell:   ${MODEL}`);
  console.log(`Kontext:  ${NUM_CTX}`);
  console.log(`Körök:    ${ROUNDS} (módonként)`);
  console.log('');

  // eloszor megnezzuk, hogy egyaltalan el-e az ollama
  try {
    const response = await fetch(`${HOST}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const payload = (await response.json()) as { version?: string };
    console.log(`Ollama verzió: ${payload.version ?? 'ismeretlen'}`);

    if (payload.version) {
      const major = Number(payload.version.split('.')[0]);
      const minor = Number(payload.version.split('.')[1]);

      if (major === 0 && minor < 5) {
        console.log('');
        console.log('!! FIGYELEM: a strukturált kimenethez legalább 0.5.0 kell.');
        console.log('   Ezzel a verzióval a teszt biztosan elbukik.');
      }
    }
  } catch (error) {
    console.log('');
    console.log('!! Az Ollama nem érhető el.');
    console.log(`   ${error instanceof Error ? error.message : String(error)}`);
    console.log('');
    console.log('   Ellenőrizd, hogy fut-e az Ollama szolgáltatás.');
    process.exit(1);
  }

  const results: Record<'think' | 'nothink', RoundResult[]> = {
    think: [],
    nothink: [],
  };

  // --- gondolkodassal ---
  console.log('');
  console.log('--- think: true ---');

  for (let i = 1; i <= ROUNDS; i++) {
    process.stdout.write(`  ${i}. kör... `);

    const result = await runRound(true);
    results.think.push(result);

    if (result.ok) {
      console.log(`OK (${(result.durationMs / 1000).toFixed(1)} mp)`);
    } else {
      console.log(`HIBA: ${result.error ?? 'ismeretlen'}`);
    }
  }

  // --- gondolkodas nelkul ---
  console.log('');
  console.log('--- think: false ---');

  for (let i = 1; i <= ROUNDS; i++) {
    process.stdout.write(`  ${i}. kör... `);

    const result = await runRound(false);
    results.nothink.push(result);

    if (result.ok) {
      console.log(`OK (${(result.durationMs / 1000).toFixed(1)} mp)`);
    } else {
      console.log(`HIBA: ${result.error ?? 'ismeretlen'}`);
    }
  }

  // --- osszegzes ---
  const thinkOk = results.think.filter((r) => r.ok).length;
  const nothinkOk = results.nothink.filter((r) => r.ok).length;

  const avgDuration = (list: RoundResult[]): string => {
    const sum = list.reduce((acc, r) => acc + r.durationMs, 0);
    return (sum / list.length / 1000).toFixed(1);
  };

  console.log('');
  console.log('='.repeat(70));
  console.log('EREDMÉNY');
  console.log('='.repeat(70));
  console.log(
    `think: true  → ${thinkOk}/${ROUNDS} sikeres, átlag ${avgDuration(results.think)} mp`,
  );
  console.log(
    `think: false → ${nothinkOk}/${ROUNDS} sikeres, átlag ${avgDuration(results.nothink)} mp`,
  );
  console.log('');

  // --- javaslat ---
  console.log('JAVASLAT:');

  if (nothinkOk === ROUNDS) {
    console.log('  A modell think: false mellett is megbízhatóan tartja a sémát.');
    console.log('  A segédhívásoknál (router, memória, compaction) maradhat a');
    console.log('  think: false — ez lesz a gyorsabb.');
    console.log('');
    console.log('  Beállítás: minden marad az alapértelmezetten.');
  } else if (thinkOk === ROUNDS && nothinkOk < ROUNDS) {
    console.log('  !! A modell think: false mellett NEM tartja megbízhatóan a sémát.');
    console.log('  Ez az ismert buktató: a thinking kikapcsolása csendben');
    console.log('  eldobja a format kényszert.');
    console.log('');
    console.log('  TEENDŐ: az ollamaOneShot alapértelmezett think értékét');
    console.log('  állítsd true-ra, vagy a segédhívásoknál add át explicit.');
    console.log('  Lassabb lesz, de működik.');
  } else if (thinkOk < ROUNDS && nothinkOk < ROUNDS) {
    console.log('  !! A modell egyik módban sem tartja megbízhatóan a sémát.');
    console.log('');
    console.log('  Lehetséges okok:');
    console.log('   - túl régi Ollama verzió (0.5.0 alatt nincs structured output)');
    console.log('   - a modell nem támogatja a grammar-kényszerítést');
    console.log('   - a modell túl kicsi az utasításkövetéshez');
    console.log('');
    console.log('  TEENDŐ: próbálj másik modellt, vagy frissítsd az Ollamát.');
    console.log('  Enélkül a router, a memória-tanulás és a compaction');
    console.log('  megbízhatatlan lesz.');
  } else {
    console.log('  Vegyes eredmény. Futtasd le még egyszer több körrel:');
    console.log(`    npx tsx scripts/check-structured-output.ts --rounds 10`);
  }

  console.log('');
  console.log('Az eredményt jegyezd fel a README-be, hogy később is tudd.');
  console.log('='.repeat(70));

  // mintavalasz kiirasa, hogy lassuk, mit adott
  const sample = results.think.find((r) => r.ok) ?? results.nothink.find((r) => r.ok);

  if (sample?.data) {
    console.log('');
    console.log('Mintaválasz:');
    console.log(JSON.stringify(sample.data, null, 2));
  }
}

main().catch((error: unknown) => {
  console.error('');
  console.error('A szkript váratlan hibába ütközött:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
