// ============================================================================
// vellum - diagnostics.ts (F1)
// ============================================================================
// hardver- es ollama-diagnosztika ember altal olvashato formaban.
//
// A LEGFONTOSABB MEZO, amit meresunk: az `ollama ps` PROCESSOR oszlopa.
//
// miert: a szoveggeneralas sebesseget nem a processzor orajele hatarozza
// meg, hanem a MEMORIA SAVSZELESSEGE. minden egyes szo eloallitasahoz a
// modell vegigolvassa az osszes sulyat a memoriabol. egy 7b-s modell q4-ben
// nagyjabol 4,5 gb -- masodpercenkent 50 token azt jelenti, hogy ezt a
// 4,5 gb-ot otvenszer olvassa at masodpercenkent.
//
// ha a modell egy resze kicsordult a rendszermemoriaba, azok a retegek
// rendszermemoria-savszelessegen futnak, ami NAGYSAGRENDDEL lassabb.
// ennek javitasa MINDEN mas tuningot ver.
// ============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  DiagnosticsResult,
  LoadedModelInfo,
  DiagnosticSuggestion,
} from './shared';

const execFileAsync = promisify(execFile);

// ----------------------------------------------------------------------------
// konfiguracio
// ----------------------------------------------------------------------------

let ollamaHost = 'http://localhost:11434';

export function configureDiagnostics(host: string): void {
  ollamaHost = host;
}

// ----------------------------------------------------------------------------
// ollama ps
// ----------------------------------------------------------------------------

/**
 * lefuttatja az `ollama ps` parancsot es feldolgozza a kimenetet.
 *
 * a kimenet nagyjabol igy nez ki:
 *   NAME          ID        SIZE     PROCESSOR       UNTIL
 *   qwen3:8b      abc123    6.5 GB   100% GPU        4 minutes from now
 */
async function runOllamaPs(): Promise<LoadedModelInfo[]> {
  try {
    const { stdout } = await execFileAsync('ollama', ['ps'], { timeout: 10000, windowsHide: true });
    const lines = stdout.trim().split('\n');

    // az elso sor a fejlec
    if (lines.length < 2) return [];

    const models: LoadedModelInfo[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;

      // a mezoket tobb szokoz valasztja el, de a PROCESSOR es az UNTIL
      // mezoben is van szokoz -- ezert nem lehet egyszeruen splitelni.
      // a strategiank: regexszel szedjuk ki a jellemzo mintakat.

      const processorMatch = line.match(/(\d+)%\s*\/\s*(\d+)%\s*(CPU\/GPU)/i);
      const singleProcessorMatch = line.match(/(\d+)%\s+(CPU|GPU)/i);

      let processor = 'ismeretlen';
      let gpuPercent: number | null = null;

      if (processorMatch) {
        // vegyes: "48%/52% CPU/GPU"
        processor = `${processorMatch[1]}%/${processorMatch[2]}% CPU/GPU`;
        gpuPercent = Number(processorMatch[2]);
      } else if (singleProcessorMatch) {
        // tiszta: "100% GPU"
        processor = `${singleProcessorMatch[1]}% ${singleProcessorMatch[2].toUpperCase()}`;
        gpuPercent =
          singleProcessorMatch[2].toUpperCase() === 'GPU'
            ? Number(singleProcessorMatch[1])
            : 0;
      }

      // a meret: "6.5 GB" vagy "17 GB"
      const sizeMatch = line.match(/(\d+(?:\.\d+)?)\s*(GB|MB)/i);
      let sizeBytes = 0;

      if (sizeMatch) {
        const value = Number(sizeMatch[1]);
        sizeBytes =
          sizeMatch[2].toUpperCase() === 'GB'
            ? value * 1024 * 1024 * 1024
            : value * 1024 * 1024;
      }

      // a nev az elso mezo
      const name = line.split(/\s+/)[0] ?? 'ismeretlen';

      // az until a sor vege
      const untilMatch = line.match(/((?:\d+\s+\w+\s+from\s+now)|Forever|Stopping)/i);
      const until = untilMatch ? untilMatch[1] : '';

      models.push({ name, sizeBytes, processor, gpuPercent, until });
    }

    return models;
  } catch {
    // az ollama cli nem elerheto (pl. csak a szerver fut mashol)
    return [];
  }
}

// ----------------------------------------------------------------------------
// ollama verzio
// ----------------------------------------------------------------------------

async function getOllamaVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${ollamaHost}/api/version`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const payload = (await response.json()) as { version?: string };
    return payload.version ?? null;
  } catch {
    return null;
  }
}

/** verzio-osszehasonlitas: a > b ? */
function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number(part.replace(/\D/g, '')) || 0);

  const current = parse(version);
  const required = parse(minimum);

  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;

    if (a > b) return true;
    if (a < b) return false;
  }

  return true;
}

// ----------------------------------------------------------------------------
// kornyezeti valtozok
// ----------------------------------------------------------------------------

function readEnvVars(): DiagnosticsResult['envVars'] {
  return {
    OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE ?? null,
    OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE ?? null,
    OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? null,
  };
}

// ----------------------------------------------------------------------------
// javaslatok
// ----------------------------------------------------------------------------

/**
 * a mert adatokbol ember altal ertheto javaslatokat csinal.
 *
 * a sorrend szamit: a legfontosabb elore. a cpu-ra kicsordult modell
 * javitasa mindent ver, azt kell eloszor mondani.
 */
function buildSuggestions(
  models: LoadedModelInfo[],
  version: string | null,
  envVars: DiagnosticsResult['envVars'],
): DiagnosticSuggestion[] {
  const suggestions: DiagnosticSuggestion[] = [];

  // --- 1. a legfontosabb: kicsordult-e a modell a cpu-ra ---
  for (const model of models) {
    if (model.gpuPercent !== null && model.gpuPercent < 100) {
      const cpuPercent = 100 - model.gpuPercent;

      suggestions.push({
        severity: 'critical',
        title: `${cpuPercent}% of the ${model.name} model runs on the CPU`,
        detail:
          'This is the main cause of slowness: layers on the CPU run at system-memory ' +
          'bandwidth, an order of magnitude slower than VRAM. Fixing it beats any other ' +
          'tuning. Try a smaller quantization, a smaller context, or free up VRAM.',
      });
    }
  }

  if (models.length === 0) {
    suggestions.push({
      severity: 'info',
      title: 'No model is loaded right now',
      detail:
        'The first question starts with a cold load, which can take several seconds. ' +
        'With OLLAMA_KEEP_ALIVE the model can stay in memory.',
    });
  }

  // --- 2. ollama verzio ---
  if (version === null) {
    suggestions.push({
      severity: 'critical',
      title: 'Ollama is not reachable',
      detail: `Could not connect to ${ollamaHost}. Check that the Ollama service is running.`,
    });
  } else {
    if (!isVersionAtLeast(version, '0.5.0')) {
      suggestions.push({
        severity: 'critical',
        title: `Ollama is too old (${version})`,
        detail:
          'Structured output (JSON-schema constrained decoding) needs at least 0.5.0. ' +
          'Without it the router, the memory import and the summaries are unreliable.',
      });
    } else if (!isVersionAtLeast(version, '0.30.0')) {
      suggestions.push({
        severity: 'warning',
        title: `Ollama is older than 0.30 (${version})`,
        detail:
          'Since 0.30.0 flash attention is switched on automatically for modern ' +
          'architectures (qwen3, qwen3moe, gemma3) on Ampere or newer NVIDIA cards. ' +
          'With an older version it has to be set by hand.',
        command: 'setx OLLAMA_FLASH_ATTENTION 1',
      });
    }
  }

  // --- 3. kornyezeti valtozok ---
  if (envVars.OLLAMA_KV_CACHE_TYPE === null) {
    suggestions.push({
      severity: 'warning',
      title: 'OLLAMA_KV_CACHE_TYPE is not set',
      detail:
        'q8_0 halves the KV-cache memory, which allows a larger context or more ' +
        'layers on the GPU.',
      command: 'setx OLLAMA_KV_CACHE_TYPE q8_0',
    });
  }

  if (envVars.OLLAMA_KEEP_ALIVE === null) {
    suggestions.push({
      severity: 'info',
      title: 'OLLAMA_KEEP_ALIVE is not set',
      detail:
        'By default the model is unloaded after 5 minutes and the next question ' +
        'starts with a cold load. -1 keeps it loaded.',
      command: 'setx OLLAMA_KEEP_ALIVE -1',
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      severity: 'info',
      title: 'All good',
      detail: 'Nothing to tune was found.',
    });
  }

  return suggestions;
}

// ----------------------------------------------------------------------------
// nyers szoveg a hibajelenteshez
// ----------------------------------------------------------------------------

function buildRawText(
  version: string | null,
  models: LoadedModelInfo[],
  envVars: DiagnosticsResult['envVars'],
  suggestions: DiagnosticSuggestion[],
): string {
  const lines: string[] = [
    '=== Vellum diagnostics ===',
    `Time: ${new Date().toISOString()}`,
    `Ollama host: ${ollamaHost}`,
    `Ollama version: ${version ?? 'not available'}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Node: ${process.version}`,
    '',
    '--- Loaded models ---',
  ];

  if (models.length === 0) {
    lines.push('(no model loaded)');
  } else {
    for (const model of models) {
      const gb = (model.sizeBytes / 1024 / 1024 / 1024).toFixed(1);
      lines.push(`${model.name} | ${gb} GB | ${model.processor} | ${model.until}`);
    }
  }

  lines.push('', '--- Environment variables ---');

  for (const [key, value] of Object.entries(envVars)) {
    lines.push(`${key} = ${value ?? '(not set)'}`);
  }

  lines.push('', '--- Suggestions ---');

  for (const suggestion of suggestions) {
    lines.push(`[${suggestion.severity.toUpperCase()}] ${suggestion.title}`);
    lines.push(`  ${suggestion.detail}`);

    if (suggestion.command) {
      lines.push(`  Command: ${suggestion.command}`);
    }
  }

  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// fo fuggveny
// ----------------------------------------------------------------------------

export async function runDiagnostics(): Promise<DiagnosticsResult> {
  // parhuzamosan futtatjuk, mert egyik sem fugg a masiktol
  const [version, models] = await Promise.all([
    getOllamaVersion(),
    runOllamaPs(),
  ]);

  const envVars = readEnvVars();
  const suggestions = buildSuggestions(models, version, envVars);
  const rawText = buildRawText(version, models, envVars, suggestions);

  return {
    ollamaReachable: version !== null,
    ollamaVersion: version,
    loadedModels: models,
    envVars,
    suggestions,
    rawText,
  };
}

// ----------------------------------------------------------------------------
// gyors kapcsolat-teszt
// ----------------------------------------------------------------------------

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  availableModels: string[];
  error?: string;
}

export async function testConnection(): Promise<ConnectionTest> {
  const startedAt = Date.now();

  try {
    const response = await fetch(`${ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(8000),
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        availableModels: [],
        error: `HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as {
      models?: { name: string }[];
    };

    return {
      ok: true,
      latencyMs,
      availableModels: (payload.models ?? []).map((m) => m.name),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      availableModels: [],
      error:
        error instanceof Error
          ? error.message
          : 'could not connect to Ollama',
    };
  }
}
