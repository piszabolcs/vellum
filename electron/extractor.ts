// ============================================================================
// vellum - extractor.ts (F8)
// ============================================================================
// readability-szeru kivonatolas: a nyers html-bol kiszedi a lenyeget.
//
// MIERT KELL: a nyers html tele van menuvel, labjeggyzettel, cookie
// bannerrel, reklammal. ha ez bekerul a kontextusba, az tiszta zaj --
// es a "lost in the middle" miatt pont a lenyeget nyomja el.
//
// BIZTONSAGI SZEREPE IS VAN: a script, style, form es rejtett elemek
// eltavolitasa csokkenti a prompt injection feluletet. egy tamado
// elrejthet utasitast egy display:none divben, ami a felhasznalonak
// lathatatlan, de a modellnek nem.
//
// nem hasznalunk kulso konyvtarat (jsdom, readability), mert azok nagyok
// es az electron main processben feleslegesen novelnek a csomagot.
// ez az egyszeru heurisztikus valtozat a gyakorlatban eleg jol mukodik.
// ============================================================================

// ----------------------------------------------------------------------------
// html tisztitas
// ----------------------------------------------------------------------------

/** azok az elemek, amiknek a TARTALMA is torlendo */
const REMOVE_WITH_CONTENT = [
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'form',
  'button',
  'select',
  'textarea',
  'nav',
  'footer',
  'aside',
];

/**
 * eltavolitja a megadott elemeket a tartalmukkal egyutt.
 *
 * regexet hasznalunk, nem parsert. ez elmeletileg torekenyebb, de
 * a celunkhoz eleg: nem kell tokeletes html fat epitenunk, csak
 * a zajt kell kiszednunk.
 */
function stripElements(html: string, tags: string[]): string {
  let result = html;

  for (const tag of tags) {
    // nyito tag, barmilyen attributummal, majd barmi, majd zaro tag
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    result = result.replace(pattern, ' ');

    // onlezaro vagy parositatlan valtozat
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    result = result.replace(selfClosing, ' ');
  }

  return result;
}

/** html kommentek eltavolitasa (ide is rejthetnek injekciot) */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * a rejtett elemek eltavolitasa.
 *
 * ez fontos biztonsagi lepes: a display:none vagy visibility:hidden
 * elemek a felhasznalonak lathatatlanok, de a szoveges kivonatba
 * bekerulnenek. pont ide szoktak prompt injectiont rejteni.
 */
function stripHiddenElements(html: string): string {
  // olyan div/span/p, aminek a style attributumaban rejtes van
  const hiddenPattern =
    /<(\w+)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

  let result = html.replace(hiddenPattern, ' ');

  // aria-hidden es hidden attributum
  const ariaPattern =
    /<(\w+)\b[^>]*(?:aria-hidden\s*=\s*["']true["']|\shidden(?:\s|>))[^>]*>[\s\S]*?<\/\1>/gi;

  result = result.replace(ariaPattern, ' ');

  return result;
}

// ----------------------------------------------------------------------------
// html entitasok
// ----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
  '&hellip;': '...',
  '&mdash;': '—',
  '&ndash;': '–',
  '&laquo;': '«',
  '&raquo;': '»',
  '&bdquo;': '„',
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&eacute;': 'é',
  '&aacute;': 'á',
  '&iacute;': 'í',
  '&oacute;': 'ó',
  '&ouml;': 'ö',
  '&uacute;': 'ú',
  '&uuml;': 'ü',
  '&Eacute;': 'É',
  '&Aacute;': 'Á',
};

export function decodeEntities(text: string): string {
  let result = text;

  for (const [entity, char] of Object.entries(ENTITIES)) {
    result = result.split(entity).join(char);
  }

  // szamos entitasok: &#233; vagy &#xE9;
  result = result.replace(/&#(\d+);/g, (_, code: string) =>
    String.fromCharCode(Number(code)),
  );

  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
    String.fromCharCode(parseInt(code, 16)),
  );

  return result;
}

// ----------------------------------------------------------------------------
// cim kinyerese
// ----------------------------------------------------------------------------

export function extractTitle(html: string): string {
  // eloszor az og:title, mert az altalaban tisztabb
  const ogMatch = html.match(
    /<meta[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  );

  if (ogMatch) return decodeEntities(ogMatch[1]).trim();

  // aztan a h1
  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

  if (h1Match) {
    const text = stripTags(h1Match[1]).trim();
    if (text.length > 0) return decodeEntities(text);
  }

  // vegul a title tag
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);

  if (titleMatch) return decodeEntities(stripTags(titleMatch[1])).trim();

  return '';
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

// ----------------------------------------------------------------------------
// fo tartalom megtalalasa
// ----------------------------------------------------------------------------

/**
 * megprobalja megtalalni a fo tartalmat.
 *
 * a strategiank egyszeru: keressuk a szemantikus tarolokat (article, main),
 * es ha nincs, akkor a legtobb szoveget tartalmazo div-et.
 */
function findMainContent(html: string): string {
  // 1. article tag -- ez a legerosebb jelzes
  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch && articleMatch[1].length > 500) {
    return articleMatch[1];
  }

  // 2. main tag
  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch && mainMatch[1].length > 500) {
    return mainMatch[1];
  }

  // 3. role="main"
  const roleMatch = html.match(
    /<div\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  if (roleMatch && roleMatch[1].length > 500) {
    return roleMatch[1];
  }

  // 4. gyakori osztalynevek
  const classPatterns = [
    /class\s*=\s*["'][^"']*(?:article-body|post-content|entry-content|content-body|main-content)[^"']*["']/i,
  ];

  for (const pattern of classPatterns) {
    const match = html.match(
      new RegExp(`<div\\b[^>]*${pattern.source}[^>]*>([\\s\\S]*?)<\\/div>`, 'i'),
    );

    if (match && match[1].length > 500) return match[1];
  }

  // 5. fallback: a body teljes tartalma
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

// ----------------------------------------------------------------------------
// szoveggé alakitas
// ----------------------------------------------------------------------------

/**
 * a html-t olvashato szoveggé alakitja, a szerkezetet megtartva.
 *
 * a fejleceket markdown formatumban tartjuk meg, mert a chunkoló
 * ezekbol epiti a fejlec-lancot, ami sokat segit a keresesben.
 */
function htmlToText(html: string): string {
  let text = html;

  // fejlecek -> markdown
  for (let level = 1; level <= 6; level++) {
    const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    const prefix = '#'.repeat(level);

    text = text.replace(pattern, (_, content: string) => {
      const clean = stripTags(content).trim();
      return clean.length > 0 ? `\n\n${prefix} ${clean}\n\n` : '\n';
    });
  }

  // listaelemek
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, content: string) => {
    const clean = stripTags(content).trim();
    return clean.length > 0 ? `\n- ${clean}` : '';
  });

  // bekezdesek es sortoresek
  text = text.replace(/<\/p>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/div>/gi, '\n');
  text = text.replace(/<\/tr>/gi, '\n');
  text = text.replace(/<\/td>/gi, ' | ');
  text = text.replace(/<\/th>/gi, ' | ');

  // kodblokkok megtartasa
  text = text.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, content: string) => {
      const clean = stripTags(content);
      return `\n\n\`\`\`\n${decodeEntities(clean).trim()}\n\`\`\`\n\n`;
    },
  );

  // minden maradek tag eltavolitasa
  text = stripTags(text);

  // entitasok dekodolasa
  text = decodeEntities(text);

  // whitespace normalizalas
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

// ----------------------------------------------------------------------------
// zaj-sorok szurese
// ----------------------------------------------------------------------------

/** tipikus cookie/menu/labjegyzet szovegek, amik nem a tartalom reszei */
const NOISE_PATTERNS = [
  /^(elfogadom|accept|cookie|süti)/i,
  /^(menü|menu|navigáció|navigation)$/i,
  /^(bejelentkezés|regisztráció|login|register|sign in)$/i,
  /^(megosztás|share|facebook|twitter|linkedin)$/i,
  /^(hirdetés|advertisement|reklám)$/i,
  /^(kapcsolat|contact|impresszum|imprint)$/i,
  /^(adatvédelem|privacy policy|felhasználási feltételek)$/i,
  /^(minden jog fenntartva|all rights reserved|copyright|©)/i,
  /^(kövess minket|follow us|iratkozz fel|subscribe)/i,
];

function removeNoiseLines(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // ures sorok megmaradnak (a bekezdes-hatarokhoz kellenek)
    if (trimmed.length === 0) {
      kept.push(line);
      continue;
    }

    // fejleceket sosem dobunk el
    if (trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }

    // zaj-mintak
    if (NOISE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      continue;
    }

    // nagyon rovid, nem mondat jellegu sorok (valoszinuleg menupontok).
    // a listaelemeket megtartjuk, mert azok lehetnek ertekes tartalom.
    if (trimmed.length < 4 && !trimmed.startsWith('-')) {
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ----------------------------------------------------------------------------
// publikus api
// ----------------------------------------------------------------------------

export interface ExtractResult {
  ok: boolean;
  title: string;
  text: string;
  /** hany karaktert dobtunk el a tisztitas soran */
  reductionPercent: number;
  error?: string;
}

/**
 * kivonatolja a lenyeget egy html oldalbol.
 */
export function extractContent(html: string): ExtractResult {
  if (!html || html.length === 0) {
    return {
      ok: false,
      title: '',
      text: '',
      reductionPercent: 0,
      error: 'üres HTML',
    };
  }

  const originalLength = html.length;

  try {
    // a cimet a tisztitas ELOTT szedjuk ki, mert a title tag a head-ben van
    const title = extractTitle(html);

    // biztonsagi tisztitas
    let cleaned = stripComments(html);
    cleaned = stripHiddenElements(cleaned);
    cleaned = stripElements(cleaned, REMOVE_WITH_CONTENT);

    // fo tartalom megtalalasa
    const main = findMainContent(cleaned);

    // szoveggé alakitas
    let text = htmlToText(main);
    text = removeNoiseLines(text);

    if (text.length < 100) {
      return {
        ok: false,
        title,
        text,
        reductionPercent: 0,
        error: 'nem sikerült érdemi tartalmat kinyerni az oldalból',
      };
    }

    const reductionPercent = Math.round(
      ((originalLength - text.length) / originalLength) * 100,
    );

    return { ok: true, title, text, reductionPercent };
  } catch (error) {
    return {
      ok: false,
      title: '',
      text: '',
      reductionPercent: 0,
      error: error instanceof Error ? error.message : 'kivonatolási hiba',
    };
  }
}
