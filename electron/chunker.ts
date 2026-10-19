// ============================================================================
// vellum - chunker.ts (F4)
// ============================================================================
// a szoveget darabokra vagja, mielott embeddinget csinalnank belole.
//
// miert szamit ez ennyire: a meresek szerint ugyanazon a korpuszon a legjobb
// es a legrosszabb chunkolasi modszer kozott akar 9 szazalekpontos
// recall-kulonbseg is lehet. ez NAGYOBB hatas, mint a modellvaltas.
//
// az alapfeszultseg egyszeru:
//   - tul nagy chunk: az embedding sok tema atlagat rogziti, higul a talalat
//   - tul kicsi chunk: onmagaban ertelmezhetetlen ("tamogat 1 millio sort"
//     -- de mi tamogat?)
//
// az 512 token a pragmatikus alapertek. az atfedesrol egy 2026 januari
// elemzes azt talalta, hogy a tesztelt beallitasban nem hozott merheto
// hasznot, csak az indexelesi koltseget novelte -- ezert nalunk ez
// hangolhato parameter, nem kotelezo alapertek.
// ============================================================================

import { estimateTokens } from './tokenizer';

// ----------------------------------------------------------------------------
// tipusok
// ----------------------------------------------------------------------------

export interface Chunk {
  /** a darab szovege, a fejlec-lanccal az elejen */
  text: string;
  /** hanyadik darab a forrasban, 0-tol */
  ord: number;
  tokenCount: number;
  /** a markdown fejlec-lanc, ha volt (pl. "# Cim > ## Alcim") */
  headingPath: string;
}

export interface ChunkOptions {
  /** cel-meret tokenben. alap: 512 */
  targetTokens?: number;
  /** atfedes tokenben. alap: 64. a 0 is teljesen ervenyes ertek. */
  overlapTokens?: number;
  /** vigyuk-e magunkkal a markdown fejleceket. alap: true */
  includeHeadings?: boolean;
  /** elotag minden chunk elejere (pl. "[felhasznalo]") */
  rolePrefix?: string;
}

const DEFAULTS = {
  targetTokens: 512,
  overlapTokens: 64,
  includeHeadings: true,
};

// ----------------------------------------------------------------------------
// kodblokk vedelme
// ----------------------------------------------------------------------------
// a kodblokkot SOHA nem vagjuk kette. ha nagyobb, mint a chunk-meret,
// akkor kulon chunk lesz, akar tulmeretes. egy felbevagott kod
// hasznalhatatlan a modellnek, es az embeddingje is felrevezeto.

interface Segment {
  text: string;
  isCode: boolean;
}

/** szetszedi a szoveget kod- es prozaszakaszokra, sorrendet megtartva */
function splitIntoSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const parts = text.split('```');

  for (let i = 0; i < parts.length; i++) {
    const content = parts[i];
    if (content.length === 0) continue;

    const isCode = i % 2 === 1;

    segments.push({
      // a kodblokknak visszaadjuk a jeloloit, hogy megmaradjon a formatum
      text: isCode ? '```' + content + '```' : content,
      isCode,
    });
  }

  return segments;
}

// ----------------------------------------------------------------------------
// markdown fejlec kovetes
// ----------------------------------------------------------------------------
// minden chunk elejere odatesszuk, hogy melyik fejlec ala tartozik.
// ez olcso (par token), es sokat segit: a "mennyi az ara" onmagaban
// ertelmetlen, de a "# Arlista > ## 2026 > mennyi az ara" mar nem.

interface HeadingState {
  /** szintenkent az aktualis fejlec szovege */
  levels: string[];
}

function updateHeadings(state: HeadingState, line: string): void {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return;

  const level = match[1].length;
  const title = match[2].trim();

  // a melyebb szinteket eldobjuk, mert uj agba leptunk
  state.levels = state.levels.slice(0, level - 1);
  state.levels[level - 1] = title;
}

function headingPathString(state: HeadingState): string {
  return state.levels.filter((h) => typeof h === 'string' && h.length > 0).join(' > ');
}

// ----------------------------------------------------------------------------
// rekurziv vagas
// ----------------------------------------------------------------------------
// a vagas sorrendje: bekezdes -> sor -> mondat -> szo -> karakter.
// mindig a legnagyobb meg mukodo egysegnel probalkozunk, es csak akkor
// megyunk finomabbra, ha az adott darab meg mindig tul nagy.

/** magyar rovidites-lista, hogy ne vagjunk mondatot rossz helyen */
const HU_ABBREVIATIONS = [
  'pl.',
  'ill.',
  'stb.',
  'ún.',
  'kb.',
  'dr.',
  'prof.',
  'ker.',
  'sz.',
  'ún.',
  'ti.',
  'vö.',
  'ált.',
  'kt.',
  'zrt.',
  'kft.',
  'bt.',
];

/** szetvagja a szoveget mondatokra, a magyar roviditeseket kikerulve */
function splitSentences(text: string): string[] {
  const rough = text.split(/(?<=[.!?])\s+/);
  const result: string[] = [];

  for (const piece of rough) {
    const previous = result[result.length - 1];

    // ha az elozo darab roviditessel vegzodik, akkor rosszul vagtunk:
    // fuzzuk vissza
    if (previous) {
      const lastWord = previous.trim().split(/\s+/).pop()?.toLowerCase() ?? '';

      if (HU_ABBREVIATIONS.includes(lastWord)) {
        result[result.length - 1] = `${previous} ${piece}`;
        continue;
      }
    }

    result.push(piece);
  }

  return result.filter((s) => s.trim().length > 0);
}

/**
 * rekurzivan felbont egy szoveget a cel-meret ala.
 * a separators tomb sorrendje szamit: elolrol hatra probalkozunk.
 */
function recursiveSplit(text: string, targetTokens: number): string[] {
  if (estimateTokens(text) <= targetTokens) {
    return [text];
  }

  // 1. bekezdes (dupla ujsor)
  const byParagraph = text.split(/\n\s*\n/);
  if (byParagraph.length > 1) {
    return mergeUntilTarget(byParagraph, targetTokens, '\n\n');
  }

  // 2. sor
  const byLine = text.split('\n');
  if (byLine.length > 1) {
    return mergeUntilTarget(byLine, targetTokens, '\n');
  }

  // 3. mondat
  const bySentence = splitSentences(text);
  if (bySentence.length > 1) {
    return mergeUntilTarget(bySentence, targetTokens, ' ');
  }

  // 4. szo
  const byWord = text.split(/\s+/);
  if (byWord.length > 1) {
    return mergeUntilTarget(byWord, targetTokens, ' ');
  }

  // 5. karakter (vegso eset: egyetlen orias szo)
  return splitByCharacters(text, targetTokens);
}

/**
 * osszefuzi a darabokat addig, amig el nem erik a cel-meretet.
 * ha egy darab onmagaban nagyobb, mint a cel, azt tovabb bontja.
 */
function mergeUntilTarget(
  pieces: string[],
  targetTokens: number,
  joiner: string,
): string[] {
  const result: string[] = [];
  let current = '';

  for (const piece of pieces) {
    const candidate = current.length === 0 ? piece : current + joiner + piece;

    if (estimateTokens(candidate) <= targetTokens) {
      current = candidate;
      continue;
    }

    // az aktualis darab lezarul
    if (current.length > 0) {
      result.push(current);
      current = '';
    }

    // ha maga a piece is tul nagy, tovabb bontjuk
    if (estimateTokens(piece) > targetTokens) {
      result.push(...recursiveSplit(piece, targetTokens));
    } else {
      current = piece;
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

function splitByCharacters(text: string, targetTokens: number): string[] {
  // durva becsles: hany karakter fer bele a cel-tokenszamba
  const charsPerChunk = Math.max(100, targetTokens * 3);
  const result: string[] = [];

  for (let i = 0; i < text.length; i += charsPerChunk) {
    result.push(text.slice(i, i + charsPerChunk));
  }

  return result;
}

// ----------------------------------------------------------------------------
// atfedes
// ----------------------------------------------------------------------------

/**
 * hozzafuzi az elozo darab vegerol az atfedest.
 * ha az overlapTokens 0, ez a fuggveny nem csinal semmit.
 */
function applyOverlap(chunks: string[], overlapTokens: number): string[] {
  if (overlapTokens <= 0 || chunks.length < 2) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1];
    const tail = takeTailTokens(previous, overlapTokens);

    result.push(tail.length > 0 ? `${tail}\n\n${chunks[i]}` : chunks[i]);
  }

  return result;
}

/** kiveszi egy szoveg vegerol a kert token-mennyisegnyi reszt, szohataron */
function takeTailTokens(text: string, tokens: number): string {
  const words = text.split(/\s+/);
  const taken: string[] = [];

  for (let i = words.length - 1; i >= 0; i--) {
    taken.unshift(words[i]);
    if (estimateTokens(taken.join(' ')) >= tokens) break;
  }

  return taken.join(' ');
}

// ----------------------------------------------------------------------------
// fo fuggveny
// ----------------------------------------------------------------------------

/**
 * feldarabolja a szoveget indexelheto chunkokra.
 */
export function chunkText(text: string, options?: ChunkOptions): Chunk[] {
  const targetTokens = options?.targetTokens ?? DEFAULTS.targetTokens;
  const overlapTokens = options?.overlapTokens ?? DEFAULTS.overlapTokens;
  const includeHeadings = options?.includeHeadings ?? DEFAULTS.includeHeadings;
  const rolePrefix = options?.rolePrefix ?? '';

  if (!text || text.trim().length === 0) return [];

  const segments = splitIntoSegments(text);
  const rawChunks: { text: string; headingPath: string }[] = [];

  const headingState: HeadingState = { levels: [] };

  for (const segment of segments) {
    // a kodblokk mindig egyben marad, meg ha tulmeretes is
    if (segment.isCode) {
      rawChunks.push({
        text: segment.text,
        headingPath: includeHeadings ? headingPathString(headingState) : '',
      });
      continue;
    }

    // a prozaresznel soronkent kovetjuk a fejleceket, majd vagunk
    const lines = segment.text.split('\n');
    let buffer: string[] = [];
    let bufferHeading = includeHeadings ? headingPathString(headingState) : '';

    const flushBuffer = (): void => {
      const joined = buffer.join('\n').trim();
      if (joined.length === 0) {
        buffer = [];
        return;
      }

      const pieces = recursiveSplit(joined, targetTokens);
      for (const piece of pieces) {
        rawChunks.push({ text: piece, headingPath: bufferHeading });
      }

      buffer = [];
    };

    for (const line of lines) {
      const isHeading = /^#{1,6}\s+/.test(line);

      if (isHeading && includeHeadings) {
        // uj fejlec -> lezarjuk az eddigi puffert, es frissitjuk a lancot
        flushBuffer();
        updateHeadings(headingState, line);
        bufferHeading = headingPathString(headingState);
      }

      buffer.push(line);
    }

    flushBuffer();
  }

  // atfedes alkalmazasa (csak a proza chunkokra van ertelme, de az
  // egyszeruseg kedveert mindenre egysegesen csinaljuk)
  const withOverlap = applyOverlap(
    rawChunks.map((c) => c.text),
    overlapTokens,
  );

  // vegso osszeallitas: elotag + fejlec-lanc + szoveg
  const result: Chunk[] = [];

  for (let i = 0; i < withOverlap.length; i++) {
    const headingPath = rawChunks[i]?.headingPath ?? '';

    const parts: string[] = [];
    if (rolePrefix) parts.push(rolePrefix);
    if (headingPath) parts.push(`[${headingPath}]`);
    parts.push(withOverlap[i]);

    const finalText = parts.join(' ').trim();

    if (finalText.length === 0) continue;

    result.push({
      text: finalText,
      ord: result.length,
      tokenCount: estimateTokens(finalText),
      headingPath,
    });
  }

  return result;
}

/**
 * egy beszelgetes-uzenetet darabol fel.
 * a szerep is bekerul a szovegbe, hogy kesobb visszakeresve tudjuk,
 * ki mondta.
 */
export function chunkMessage(
  content: string,
  role: 'user' | 'assistant',
  options?: ChunkOptions,
): Chunk[] {
  const prefix = role === 'user' ? '[felhasználó]' : '[asszisztens]';
  return chunkText(content, { ...options, rolePrefix: prefix });
}
