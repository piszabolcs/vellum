// ============================================================================
// vellum - tools/files.ts (F6)
// ============================================================================
// sandboxolt fajlolvasas.
//
// EZ AZ EGYIK LEGVESZELYESEBB ESZKOZ, ezert a legszigorubb korlatok:
//   - csak a felhasznalo altal kijelolt gyokermappa ALATT
//   - csak olvasas, iras SOHA
//   - path traversal tiltas (.. , abszolut ut, symlink feloldas utan is)
//   - kiterjesztes-feherlista, binaris tilos
//   - meretkorlat
//
// a symlink feloldas kulon fontos: valaki (vagy egy prompt injection)
// csinalhat egy symlinket a gyokermappan belul, ami kifele mutat.
// ezert a valos utat (realpath) ellenorizzuk, nem a megadottat.
// ============================================================================

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';
import { estimateTokens } from '../tokenizer';
import { DATA_FRAMES, frameAsData } from '../shared';

// ----------------------------------------------------------------------------
// korlatok
// ----------------------------------------------------------------------------

/** max fajlmeret bajtban. e folott nem olvassuk be. */
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 mb

/** e folott artifactba kerul es csak reszlet megy a modellnek */
const INLINE_TOKEN_LIMIT = 600;

/** engedelyezett kiterjesztesek. minden mas tilos. */
const ALLOWED_EXTENSIONS = new Set([
  // szoveg es dokumentum
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.log',
  // strukturalt adat
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  // kod
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.sql',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  // ipari / plc kornyezet, ami a felhasznalonal elofordulhat
  '.st',
  '.scl',
  '.awl',
  '.gcode',
  '.nc',
]);

// ----------------------------------------------------------------------------
// biztonsagi ellenorzesek
// ----------------------------------------------------------------------------

export interface PathCheckResult {
  ok: boolean;
  /** a feloldott, biztonsagos abszolut ut */
  resolvedPath?: string;
  error?: string;
}

/**
 * ellenorzi, hogy a kert ut a gyokermappan belul van-e.
 *
 * a lepesek sorrendje szamit:
 *   1. van-e egyaltalan beallitva gyokermappa
 *   2. a nyers uton is szurunk (gyors elutasitas)
 *   3. feloldjuk a valos utat (symlinkekkel egyutt)
 *   4. a VALOS utat hasonlitjuk a VALOS gyokerhez
 */
export async function checkPathSafety(
  requestedPath: string,
  rootPath: string,
): Promise<PathCheckResult> {
  if (!rootPath || rootPath.trim().length === 0) {
    return {
      ok: false,
      error:
        'nincs beállítva fájl-gyökérmappa. A Beállításokban kell kijelölni egyet, ' +
        'mielőtt ez az eszköz használható lenne.',
    };
  }

  if (!requestedPath || requestedPath.trim().length === 0) {
    return { ok: false, error: 'üres útvonal' };
  }

  // null byte injekcio elleni vedelem
  if (requestedPath.includes('\0')) {
    return { ok: false, error: 'érvénytelen karakter az útvonalban' };
  }

  // gyors elutasitas: nyilvanvalo traversal kiserletek
  const normalized = path.normalize(requestedPath);

  if (normalized.split(/[\\/]/).includes('..')) {
    return {
      ok: false,
      error: 'a "..\" használata nem megengedett az útvonalban',
    };
  }

  // ha abszolut utat adtak meg, annak is a gyokeren belul kell lennie
  const candidate = path.isAbsolute(normalized)
    ? normalized
    : path.join(rootPath, normalized);

  // a valos utak feloldasa. ez oldja fel a symlinkeket is.
  let realRoot: string;
  let realTarget: string;

  try {
    realRoot = await fs.realpath(rootPath);
  } catch {
    return {
      ok: false,
      error: `a beállított gyökérmappa nem elérhető: ${rootPath}`,
    };
  }

  try {
    realTarget = await fs.realpath(candidate);
  } catch {
    return { ok: false, error: `a fájl nem található: ${requestedPath}` };
  }

  // a vegso ellenorzes: a valos cel a valos gyokeren belul van-e.
  // a path.relative akkor ad ".."-vel kezdodo eredmenyt, ha kivul van.
  const relative = path.relative(realRoot, realTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      ok: false,
      error: 'az útvonal a kijelölt mappán kívülre mutat, ez nem megengedett',
    };
  }

  return { ok: true, resolvedPath: realTarget };
}

/** Names that usually hold secrets: never handed to the model, whatever the extension. */
const SECRET_NAME = /(^|\.)env($|\.)|\.(pem|key|pfx|p12|kdbx)$|^id_(rsa|dsa|ecdsa|ed25519)|^credentials/i;

/** kiterjesztes ellenorzese */
export function isAllowedExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (SECRET_NAME.test(path.basename(filePath))) return false;

  // kiterjesztes nelkuli fajlok (pl. Makefile, Dockerfile) engedelyezettek,
  // ha a nevuk ismert szoveges fajl
  if (extension === '') {
    const base = path.basename(filePath).toLowerCase();
    return ['makefile', 'dockerfile', 'readme', 'license', 'changelog'].includes(
      base,
    );
  }

  return ALLOWED_EXTENSIONS.has(extension);
}

/**
 * megnezi, hogy a tartalom binaris-e.
 *
 * egyszeru heurisztika: ha van benne null byte az elso 8 kb-ban,
 * akkor binaris. a szoveges fajlokban ez sosem fordul elo.
 */
function looksBinary(buffer: Buffer): boolean {
  const sampleSize = Math.min(8192, buffer.length);

  for (let i = 0; i < sampleSize; i++) {
    if (buffer[i] === 0) return true;
  }

  return false;
}

// ----------------------------------------------------------------------------
// mappa listazas
// ----------------------------------------------------------------------------

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: number;
}

export async function listDirectory(
  dirPath: string,
  rootPath: string,
): Promise<{ ok: boolean; entries?: DirectoryEntry[]; error?: string }> {
  const check = await checkPathSafety(dirPath, rootPath);

  if (!check.ok || !check.resolvedPath) {
    return { ok: false, error: check.error };
  }

  try {
    const names = await fs.readdir(check.resolvedPath);
    const entries: DirectoryEntry[] = [];

    for (const name of names) {
      // rejtett fajlokat kihagyjuk
      if (name.startsWith('.')) continue;

      try {
        const stat = await fs.stat(path.join(check.resolvedPath, name));

        entries.push({
          name,
          isDirectory: stat.isDirectory(),
          sizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // egy elerhetetlen bejegyzes miatt ne alljon meg a listazas
        continue;
      }
    }

    // mappak elore, aztan nev szerint
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, 'hu');
    });

    return { ok: true, entries };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'nem sikerült listázni a mappát',
    };
  }
}

// ----------------------------------------------------------------------------
// olvasas
// ----------------------------------------------------------------------------

export interface ReadFileResult {
  ok: boolean;
  content?: string;
  sizeBytes?: number;
  tokenCount?: number;
  error?: string;
}

export async function readFileSafe(
  filePath: string,
  rootPath: string,
): Promise<ReadFileResult> {
  const check = await checkPathSafety(filePath, rootPath);

  if (!check.ok || !check.resolvedPath) {
    return { ok: false, error: check.error };
  }

  if (!isAllowedExtension(check.resolvedPath)) {
    return {
      ok: false,
      error:
        `ez a fájltípus nem olvasható. Engedélyezett kiterjesztések: ` +
        `${[...ALLOWED_EXTENSIONS].slice(0, 15).join(', ')} és hasonlók.`,
    };
  }

  try {
    const stat = await fs.stat(check.resolvedPath);

    if (stat.isDirectory()) {
      return {
        ok: false,
        error: 'ez egy mappa, nem fájl. Használd a list_directory eszközt.',
      };
    }

    if (stat.size > MAX_FILE_BYTES) {
      const mb = (stat.size / 1024 / 1024).toFixed(1);
      return {
        ok: false,
        error: `a fájl túl nagy (${mb} MB). A korlát 5 MB.`,
      };
    }

    const buffer = await fs.readFile(check.resolvedPath);

    if (looksBinary(buffer)) {
      return {
        ok: false,
        error: 'ez bináris fájl, nem olvasható szövegként',
      };
    }

    const content = buffer.toString('utf-8');

    return {
      ok: true,
      content,
      sizeBytes: stat.size,
      tokenCount: estimateTokens(content),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'nem sikerült beolvasni a fájlt',
    };
  }
}

// ----------------------------------------------------------------------------
// tool definiciok
// ----------------------------------------------------------------------------

const ReadFileArgsSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .describe('A fájl útvonala a kijelölt gyökérmappához képest.'),
  query: z
    .string()
    .optional()
    .describe(
      'Ha a fájl nagy, ezzel adhatod meg, mit keresel benne. ' +
        'Ilyenkor csak a releváns rész jön vissza.',
    ),
});

type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

export const readFileTool: ToolDef<ReadFileArgs> = {
  name: 'read_file',
  category: 'files',
  shortDescription: 'fájlok olvasása a kijelölt mappából',
  description: [
    'Beolvas egy szöveges fájlt a felhasználó által kijelölt mappából.',
    'Csak olvasásra való, írni nem tud.',
    'Ha a fájl nagy, add meg a query paramétert is, hogy csak a',
    'releváns rész jöjjön vissza.',
  ].join(' '),
  schema: ReadFileArgsSchema,
  jsonSchema: zodToJsonSchema(ReadFileArgsSchema, {
    name: 'ReadFileArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 4,
  priority: 70,

  async execute(args: ReadFileArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    const result = await readFileSafe(args.path, ctx.settings.filesRootPath);

    if (!result.ok || result.content === undefined) {
      return {
        ok: false,
        forModel: '',
        errorForModel: result.error ?? 'nem sikerült beolvasni a fájlt',
        durationMs: Date.now() - startedAt,
      };
    }

    // ha kicsi, egyben megy be, adatkeretbe csomagolva
    if ((result.tokenCount ?? 0) <= INLINE_TOKEN_LIMIT) {
      const forModel = [
        DATA_FRAMES.fileContent.open,
        `Fájl: ${args.path}`,
        '',
        result.content,
        DATA_FRAMES.fileContent.close,
      ].join('\n');

      return {
        ok: true,
        data: { path: args.path, sizeBytes: result.sizeBytes },
        forModel,
        durationMs: Date.now() - startedAt,
      };
    }

    // ha nagy, artifactba kerul, es csak osszefoglalo vagy reszlet megy be.
    // a maybeOffload dinamikusan toltodik be, hogy ne legyen korkoros import.
    const { maybeOffload } = await import('../artifacts');

    const offloaded = await maybeOffload({
      kind: 'file',
      title: args.path,
      url: null,
      body: result.content,
      conversationId: ctx.conversationId,
    });

    // ha volt query, probaljuk meg egybol a relevans reszt visszaadni
    if (args.query && offloaded.artifactId) {
      const { readArtifact } = await import('../artifacts');
      const excerpt = await readArtifact(offloaded.artifactId, args.query);

      if (excerpt.ok) {
        const forModel = [
          DATA_FRAMES.fileContent.open,
          `Fájl: ${args.path} (részlet a "${args.query}" keresésre)`,
          '',
          excerpt.text,
          DATA_FRAMES.fileContent.close,
          '',
          `A teljes tartalom: read_artifact(${offloaded.artifactId})`,
        ].join('\n');

        return {
          ok: true,
          forModel,
          artifactId: offloaded.artifactId,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    return {
      ok: true,
      forModel: frameAsData(DATA_FRAMES.fileContent, offloaded.forModel),
      artifactId: offloaded.artifactId,
      durationMs: Date.now() - startedAt,
    };
  },
};

const ListDirArgsSchema = z.object({
  path: z
    .string()
    .default('.')
    .describe('A mappa útvonala a gyökérmappához képest. Alapból a gyökér.'),
});

type ListDirArgs = z.infer<typeof ListDirArgsSchema>;

export const listDirectoryTool: ToolDef<ListDirArgs> = {
  name: 'list_directory',
  category: 'files',
  shortDescription: 'mappa tartalmának listázása',
  description:
    'Kilistázza egy mappa tartalmát a kijelölt gyökérmappán belül. ' +
    'Ezzel tudod megnézni, milyen fájlok érhetők el, mielőtt olvasnál.',
  schema: ListDirArgsSchema,
  jsonSchema: zodToJsonSchema(ListDirArgsSchema, {
    name: 'ListDirArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 3,
  priority: 65,

  async execute(args: ListDirArgs, ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();

    const result = await listDirectory(
      args.path || '.',
      ctx.settings.filesRootPath,
    );

    if (!result.ok || !result.entries) {
      return {
        ok: false,
        forModel: '',
        errorForModel: result.error ?? 'nem sikerült listázni',
        durationMs: Date.now() - startedAt,
      };
    }

    if (result.entries.length === 0) {
      return {
        ok: true,
        forModel: `A(z) "${args.path}" mappa üres.`,
        durationMs: Date.now() - startedAt,
      };
    }

    const lines = [`A(z) "${args.path}" mappa tartalma:`];

    for (const entry of result.entries.slice(0, 100)) {
      if (entry.isDirectory) {
        lines.push(`  [mappa] ${entry.name}/`);
      } else {
        const kb = (entry.sizeBytes / 1024).toFixed(1);
        const readable = isAllowedExtension(entry.name) ? '' : ' (nem olvasható)';
        lines.push(`  ${entry.name} — ${kb} KB${readable}`);
      }
    }

    if (result.entries.length > 100) {
      lines.push(`  ... és további ${result.entries.length - 100} elem`);
    }

    return {
      ok: true,
      forModel: lines.join('\n'),
      durationMs: Date.now() - startedAt,
    };
  },
};
