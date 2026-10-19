// ============================================================================
// vellum - tools/calc.ts (F6)
// ============================================================================
// biztonsagos kifejezes-kiertekelo.
//
// MIERT FONTOS EZ AZ ESZKOZ: a nyelvi modell alapbol csak szoveget josol,
// nem szamol. amikor megis megprobalja, jonnek azok a hibak, amiktol a
// felhasznalo azt mondja, hogy "hat ez hulye": elszamolja a szorzast,
// rosszul kerekit. ez az egyik legkinosabb, LEGLATVANYOSABB hibaosztaly,
// es egy szamologeppel teljesen megszuntetheto.
//
// MIERT NEM eval(): az kodfuttatas lenne egy sandboxolatlan node
// kornyezetben. a modell (vagy egy prompt injection) siman irhatna
// olyat, hogy require('fs').unlinkSync(...). ezert sajat parsert irunk.
//
// a parser egy klasszikus recursive descent, ami CSAK matematikai
// kifejezeseket ismer. semmi mast nem tud ertelmezni, tehat nem is
// lehet visszaelni vele.
// ============================================================================

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { ToolDef, ToolResult, ToolContext } from './registry';

// ----------------------------------------------------------------------------
// tokenizalas
// ----------------------------------------------------------------------------

type TokenType = 'number' | 'operator' | 'lparen' | 'rparen' | 'function' | 'comma';

interface Token {
  type: TokenType;
  value: string;
}

/** az engedelyezett fuggvenyek. semmi mas nem hivhato. */
const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};

/** az engedelyezett allandok */
const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  // a magyar tizedesvesszot pontra cserejuk, de csak szamok kozott.
  // a fuggvenyargumentumok elvalasztasa is vesszo, ezert kell ovatosnak lenni.
  const text = input.replace(/(\d),(\d)/g, '$1.$2');

  while (i < text.length) {
    const char = text[i];

    // szokoz atugrasa
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // szam (tizedesponttal, exponenssel)
    if (/[0-9.]/.test(char)) {
      let numberText = '';

      while (i < text.length && /[0-9.]/.test(text[i])) {
        numberText += text[i];
        i++;
      }

      // exponencialis jeloles: 1e5, 2.5e-3
      if (i < text.length && /[eE]/.test(text[i])) {
        const save = i;
        let exponent = text[i];
        i++;

        if (i < text.length && /[+-]/.test(text[i])) {
          exponent += text[i];
          i++;
        }

        if (i < text.length && /[0-9]/.test(text[i])) {
          while (i < text.length && /[0-9]/.test(text[i])) {
            exponent += text[i];
            i++;
          }
          numberText += exponent;
        } else {
          // nem exponens volt, visszalepunk
          i = save;
        }
      }

      if (Number.isNaN(Number(numberText))) {
        throw new Error(`érvénytelen szám: "${numberText}"`);
      }

      tokens.push({ type: 'number', value: numberText });
      continue;
    }

    // fuggvenynev vagy allando
    if (/[a-zA-Z]/.test(char)) {
      let name = '';

      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) {
        name += text[i];
        i++;
      }

      const lower = name.toLowerCase();

      if (Object.hasOwn(CONSTANTS, lower)) {
        tokens.push({ type: 'number', value: String(CONSTANTS[lower]) });
        continue;
      }

      if (Object.hasOwn(FUNCTIONS, lower)) {
        tokens.push({ type: 'function', value: lower });
        continue;
      }

      throw new Error(
        `ismeretlen név: "${name}". ` +
          `Használható függvények: ${Object.keys(FUNCTIONS).join(', ')}`,
      );
    }

    // operatorok
    if ('+-*/%^'.includes(char)) {
      tokens.push({ type: 'operator', value: char });
      i++;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: char });
      i++;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: char });
      i++;
      continue;
    }

    if (char === ',' || char === ';') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }

    throw new Error(`érvénytelen karakter: "${char}"`);
  }

  return tokens;
}

// ----------------------------------------------------------------------------
// recursive descent parser
// ----------------------------------------------------------------------------
// nyelvtan (precedencia szerint, gyengetol az erosig):
//   expression := term (('+' | '-') term)*
//   term       := factor (('*' | '/' | '%') factor)*
//   factor     := unary ('^' factor)?          <- jobbra asszociativ
//   unary      := ('-' | '+')? primary
//   primary    := number | '(' expression ')' | function '(' args ')'

class Parser {
  private tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.expression();

    if (this.position < this.tokens.length) {
      throw new Error(
        `váratlan jel a kifejezés végén: "${this.tokens[this.position].value}"`,
      );
    }

    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private consume(): Token {
    const token = this.tokens[this.position];
    if (!token) throw new Error('váratlan vég a kifejezésben');
    this.position++;
    return token;
  }

  private expression(): number {
    let left = this.term();

    while (true) {
      const token = this.peek();
      if (!token || token.type !== 'operator') break;
      if (token.value !== '+' && token.value !== '-') break;

      this.consume();
      const right = this.term();

      left = token.value === '+' ? left + right : left - right;
    }

    return left;
  }

  private term(): number {
    let left = this.factor();

    while (true) {
      const token = this.peek();
      if (!token || token.type !== 'operator') break;
      if (!['*', '/', '%'].includes(token.value)) break;

      this.consume();
      const right = this.factor();

      if (token.value === '*') {
        left = left * right;
      } else if (token.value === '/') {
        if (right === 0) throw new Error('nullával való osztás');
        left = left / right;
      } else {
        if (right === 0) throw new Error('nullával való osztás (maradék)');
        left = left % right;
      }
    }

    return left;
  }

  private factor(): number {
    const base = this.unary();
    const token = this.peek();

    if (token && token.type === 'operator' && token.value === '^') {
      this.consume();
      // a hatvanyozas jobbra asszociativ: 2^3^2 = 2^(3^2)
      const exponent = this.factor();
      return Math.pow(base, exponent);
    }

    return base;
  }

  private unary(): number {
    const token = this.peek();

    if (token && token.type === 'operator') {
      if (token.value === '-') {
        this.consume();
        return -this.unary();
      }
      if (token.value === '+') {
        this.consume();
        return this.unary();
      }
    }

    return this.primary();
  }

  private primary(): number {
    const token = this.consume();

    if (token.type === 'number') {
      return Number(token.value);
    }

    if (token.type === 'lparen') {
      const value = this.expression();
      const closing = this.consume();

      if (closing.type !== 'rparen') {
        throw new Error('hiányzó záró zárójel');
      }

      return value;
    }

    if (token.type === 'function') {
      const opening = this.consume();

      if (opening.type !== 'lparen') {
        throw new Error(`a(z) ${token.value} után zárójel kell`);
      }

      const args: number[] = [this.expression()];

      while (this.peek()?.type === 'comma') {
        this.consume();
        args.push(this.expression());
      }

      const closing = this.consume();

      if (closing.type !== 'rparen') {
        throw new Error('hiányzó záró zárójel a függvényhívásban');
      }

      const fn = FUNCTIONS[token.value];
      const result = fn(...args);

      if (Number.isNaN(result)) {
        throw new Error(
          `a(z) ${token.value} függvény nem értelmezhető eredményt adott`,
        );
      }

      return result;
    }

    throw new Error(`váratlan jel: "${token.value}"`);
  }
}

// ----------------------------------------------------------------------------
// szazalek kezelese
// ----------------------------------------------------------------------------

/**
 * a "20% of 150" es a "150 + 20%" tipusu kifejezeseket alakitja at.
 *
 * ez azert kell, mert a felhasznalo (es a modell) igy fogalmaz, de a
 * parser csak tiszta matematikat ert.
 */
function normalizePercentages(input: string): string {
  let text = input;

  // "X% of Y" vagy "Y X%-a" -> (X/100)*Y
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*%\s*(?:of|-a|-e|a|az)\s+(\d+(?:\.\d+)?)/gi,
    '($1/100)*$2',
  );

  // "Y + X%" -> Y*(1+X/100)
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*%/g,
    '$1*(1+$2/100)',
  );

  // "Y - X%" -> Y*(1-X/100)
  text = text.replace(
    /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*%/g,
    '$1*(1-$2/100)',
  );

  // maradek "X%" -> (X/100)
  text = text.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)');

  return text;
}

// ----------------------------------------------------------------------------
// mertekegyseg-valtas
// ----------------------------------------------------------------------------

/** egyszeru, gyakran kello atvaltasok. minden ertek si alapegysegben. */
const UNIT_FACTORS: Record<string, { base: string; factor: number }> = {
  // hossz (meter)
  mm: { base: 'm', factor: 0.001 },
  cm: { base: 'm', factor: 0.01 },
  dm: { base: 'm', factor: 0.1 },
  m: { base: 'm', factor: 1 },
  km: { base: 'm', factor: 1000 },
  inch: { base: 'm', factor: 0.0254 },
  ft: { base: 'm', factor: 0.3048 },
  mile: { base: 'm', factor: 1609.344 },

  // tomeg (kilogramm)
  mg: { base: 'kg', factor: 0.000001 },
  g: { base: 'kg', factor: 0.001 },
  dkg: { base: 'kg', factor: 0.01 },
  kg: { base: 'kg', factor: 1 },
  t: { base: 'kg', factor: 1000 },
  lb: { base: 'kg', factor: 0.45359237 },
  oz: { base: 'kg', factor: 0.028349523 },

  // ido (masodperc)
  ms: { base: 's', factor: 0.001 },
  s: { base: 's', factor: 1 },
  min: { base: 's', factor: 60 },
  h: { base: 's', factor: 3600 },
  day: { base: 's', factor: 86400 },

  // adat (bajt)
  b: { base: 'byte', factor: 1 },
  kb: { base: 'byte', factor: 1024 },
  mb: { base: 'byte', factor: 1024 * 1024 },
  gb: { base: 'byte', factor: 1024 * 1024 * 1024 },
  tb: { base: 'byte', factor: 1024 * 1024 * 1024 * 1024 },

  // nyomas (pascal)
  pa: { base: 'pa', factor: 1 },
  kpa: { base: 'pa', factor: 1000 },
  mpa: { base: 'pa', factor: 1000000 },
  bar: { base: 'pa', factor: 100000 },
  psi: { base: 'pa', factor: 6894.757 },
};

function tryUnitConversion(
  input: string,
): { ok: true; result: string } | { ok: false } {
  // formatum: "5 km to m" vagy "5 km -> m" vagy "5km m-ben"
  const match = input.match(
    /^\s*(-?\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)\s*(?:to|->|=>|in|be|ben|ba)\s*([a-zA-Z]+)\s*$/i,
  );

  if (!match) return { ok: false };

  const amount = Number(match[1].replace(',', '.'));
  const from = match[2].toLowerCase();
  const to = match[3].toLowerCase();

  const fromUnit = UNIT_FACTORS[from];
  const toUnit = UNIT_FACTORS[to];

  if (!fromUnit || !toUnit) return { ok: false };

  if (fromUnit.base !== toUnit.base) {
    return { ok: false };
  }

  const result = (amount * fromUnit.factor) / toUnit.factor;

  return {
    ok: true,
    result: `${amount} ${from} = ${formatNumber(result)} ${to}`,
  };
}

// ----------------------------------------------------------------------------
// eredmeny formazasa
// ----------------------------------------------------------------------------

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }

  // egesz szam -> nincs tizedes
  if (Number.isInteger(value)) {
    return String(value);
  }

  // nagyon kicsi vagy nagyon nagy -> exponencialis
  if (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e15) {
    return value.toExponential(6);
  }

  // egyebkent max 10 tizedesjegy, a felesleges nullak nelkul
  return String(Number(value.toFixed(10)));
}

// ----------------------------------------------------------------------------
// publikus kiertekelo
// ----------------------------------------------------------------------------

export interface CalcResult {
  ok: boolean;
  value?: number;
  formatted?: string;
  error?: string;
}

export function evaluateExpression(input: string): CalcResult {
  if (!input || input.trim().length === 0) {
    return { ok: false, error: 'üres kifejezés' };
  }

  // tul hosszu bemenet elutasitasa (dos vedelem)
  if (input.length > 500) {
    return { ok: false, error: 'a kifejezés túl hosszú (max 500 karakter)' };
  }

  // eloszor megnezzuk, mertekegyseg-valtas-e
  const unitResult = tryUnitConversion(input);
  if (unitResult.ok) {
    return { ok: true, formatted: unitResult.result };
  }

  try {
    const normalized = normalizePercentages(input);
    const tokens = tokenize(normalized);

    if (tokens.length === 0) {
      return { ok: false, error: 'nincs kiértékelhető kifejezés' };
    }

    const parser = new Parser(tokens);
    const value = parser.parse();

    if (!Number.isFinite(value)) {
      return {
        ok: false,
        error: 'az eredmény nem véges szám (lehet, hogy nullával osztottál)',
      };
    }

    return { ok: true, value, formatted: formatNumber(value) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ----------------------------------------------------------------------------
// tool definicio
// ----------------------------------------------------------------------------

const CalcArgsSchema = z.object({
  expression: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'A kiszámolandó matematikai kifejezés, például "17*43" vagy "5 km to m".',
    ),
});

type CalcArgs = z.infer<typeof CalcArgsSchema>;

export const calculateTool: ToolDef<CalcArgs> = {
  name: 'calculate',
  category: 'compute',
  shortDescription: 'számolás, mértékegység-váltás',
  description: [
    'Kiszámol egy matematikai kifejezést. MINDIG ezt használd számoláshoz,',
    'soha ne számolj fejben.',
    'Támogat: + - * / % ^, zárójel, sqrt, abs, round, floor, ceil, min, max,',
    'pow, log, log10, log2, exp, sin, cos, tan, pi, e.',
    'Százalék: "20% of 150" vagy "150 + 20%".',
    'Mértékegység-váltás: "5 km to m", "3 bar to psi", "2 gb to mb".',
  ].join(' '),
  schema: CalcArgsSchema,
  jsonSchema: zodToJsonSchema(CalcArgsSchema, {
    name: 'CalcArgs',
    $refStrategy: 'none',
  }) as Record<string, unknown>,
  destructive: false,
  needsNetwork: false,
  maxCallsPerTurn: 5,
  priority: 90,

  async execute(args: CalcArgs, _ctx: ToolContext): Promise<ToolResult> {
    const startedAt = Date.now();
    const result = evaluateExpression(args.expression);

    if (!result.ok) {
      return {
        ok: false,
        forModel: '',
        errorForModel: `nem sikerült kiszámolni: ${result.error}`,
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      ok: true,
      data: result.value,
      forModel: `${args.expression} = ${result.formatted}`,
      durationMs: Date.now() - startedAt,
    };
  },
};
