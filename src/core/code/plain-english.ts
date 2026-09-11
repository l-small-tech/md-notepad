/**
 * Plain-English signatures (review_plan.md §2.1): one sentence per unit,
 * built from a fixed template —
 *
 *   <Name> takes <params joined with commas and "and">, and gives back <return>.
 *
 * Every rule is a row in a table here, so a wrong sentence is a one-row fix
 * with a one-line test. A parameter is phrased from its NAME first (`dir` is
 * "a folder path" whatever its type) and its TYPE second ({@link TYPE_RULES}).
 * Two overrides beat both: a `@param name text` line in the doc comment, and
 * an object / struct return type, which is spelled out field by field.
 *
 * Markdown is used for exactly two things: `*field*` names in a spelled-out
 * object, and `` `Type` `` for a type the table does not know. Everything
 * else is plain text.
 */

import type { CodeLanguage, CodeUnit, Field, Param, TypeRef } from './model';

/** Resolves a named type (a struct / interface in the same file) to its fields. */
export type FieldResolver = (name: string) => Field[] | null;

/* ---- name rules ------------------------------------------------------------ */

/**
 * A row matches the parameter's head word (the last camelCase / snake_case
 * word: `shownDirs` → `dirs`, `fileName` → `name`). `plural` is the noun a
 * plural name becomes: `dirs` → "a list of folders".
 */
export interface NameRule {
  heads: readonly string[];
  phrase: string;
  plural: string;
}

export const NAME_RULES: readonly NameRule[] = [
  { heads: ['opts', 'options', 'config'], phrase: 'options', plural: 'options' },
  {
    heads: ['cb', 'callback', 'fn', 'handler'],
    phrase: 'something to run',
    plural: 'things to run',
  },
  { heads: ['filepath'], phrase: 'a file path', plural: 'file paths' },
  { heads: ['dir', 'folder', 'path', 'directory'], phrase: 'a folder path', plural: 'folders' },
  { heads: ['name', 'filename', 'file'], phrase: 'a file name', plural: 'file names' },
  { heads: ['id'], phrase: 'an id', plural: 'ids' },
  { heads: ['text', 'content', 'source'], phrase: 'text', plural: 'texts' },
  { heads: ['count', 'n', 'len', 'length', 'index', 'i'], phrase: 'a number', plural: 'numbers' },
  { heads: ['enabled', 'flag', 'on'], phrase: 'yes or no', plural: 'yes or no values' },
];

/** `isOpen`, `hasChildren`, `shouldSave` → yes or no. */
const BOOLEAN_PREFIXES = ['is', 'has', 'should', 'can'];
/** `onClick` → something to run. */
const HANDLER_PREFIXES = ['on'];
/** `list`, `items`, `xs` → a list of whatever the type says. */
const LIST_HEADS = ['list', 'items', 'xs', 'arr', 'array'];

/* ---- type rules ------------------------------------------------------------- */

/** A row: does this type text match, and how is it phrased. */
export interface TypeRule {
  name: string;
  /** Returns the phrase, or null when the row does not apply. */
  apply: (type: string, ctx: TypeContext) => string | null;
}

export interface TypeContext {
  lang: CodeLanguage;
  /** Recurse into a nested type. */
  describe: (type: string) => string;
  resolve?: FieldResolver;
}

const NUMBER_TYPES = /^(number|bigint|usize|isize|[ui](8|16|32|64|128)|f32|f64)$/;
const TEXT_TYPES = /^(string|str|String|char)$/;
const LIST_GENERICS = /^(Array|ReadonlyArray|Vec|VecDeque|HashSet|BTreeSet|Set|LinkedList)$/;
const LOOKUP_GENERICS = /^(Record|Map|ReadonlyMap|HashMap|BTreeMap)$/;
const NOTHING_TYPES = /^(void|\(\)|undefined|null|never)$/;

export const TYPE_RULES: readonly TypeRule[] = [
  { name: 'nothing', apply: (t) => (NOTHING_TYPES.test(t) ? 'nothing' : null) },
  { name: 'text', apply: (t) => (TEXT_TYPES.test(t) ? 'text' : null) },
  { name: 'number', apply: (t) => (NUMBER_TYPES.test(t) ? 'a number' : null) },
  { name: 'yes or no', apply: (t) => (/^(boolean|bool)$/.test(t) ? 'yes or no' : null) },
  { name: 'anything', apply: (t) => (/^(any|unknown)$/.test(t) ? 'anything' : null) },
  {
    name: 'function',
    apply: (t) =>
      /^\(.*\)\s*=>/.test(t) || /^(impl |dyn |&)?(Fn|FnMut|FnOnce|fn)\b/.test(t)
        ? 'something to run'
        : null,
  },
  {
    name: 'or nothing (union)',
    apply: (t, ctx) => {
      const parts = splitTop(t, '|');
      if (parts.length < 2) {
        return null;
      }
      const rest = parts.filter((p) => !/^(null|undefined)$/.test(p));
      if (rest.length === parts.length) {
        return null;
      }
      return rest.length === 0 ? 'nothing' : `${ctx.describe(rest.join(' | '))}, or nothing`;
    },
  },
  {
    name: 'one of (literal union)',
    apply: (t) => {
      const parts = splitTop(t, '|');
      if (parts.length < 2 || !parts.every((p) => /^(['"`]).*\1$/.test(p))) {
        return null;
      }
      return `one of ${parts.join(', ')}`;
    },
  },
  {
    name: 'either (union)',
    apply: (t, ctx) => {
      const parts = splitTop(t, '|');
      return parts.length < 2 ? null : parts.map(ctx.describe).join(' or ');
    },
  },
  {
    name: 'list (T[])',
    apply: (t, ctx) => {
      const elem = arrayElement(t);
      return elem === null ? null : `a list of ${plural(ctx.describe(elem))}`;
    },
  },
  {
    name: 'list (Vec<T>, &[T])',
    apply: (t, ctx) => {
      const g = generic(t);
      if (g && LIST_GENERICS.test(g.name) && g.args.length === 1) {
        return `a list of ${plural(ctx.describe(g.args[0]!))}`;
      }
      const slice = /^\[(.+?)(?:;\s*[^;\]]+)?\]$/.exec(t);
      if (slice && ctx.lang === 'rust' && splitTop(slice[1]!, ',').length === 1) {
        return `a list of ${plural(ctx.describe(slice[1]!))}`;
      }
      return null;
    },
  },
  {
    name: 'lookup',
    apply: (t, ctx) => {
      const g = generic(t);
      if (!g || !LOOKUP_GENERICS.test(g.name) || g.args.length !== 2) {
        return null;
      }
      return `a lookup of ${plural(ctx.describe(g.args[1]!))} by ${noArticle(ctx.describe(g.args[0]!))}`;
    },
  },
  {
    name: 'option',
    apply: (t, ctx) => {
      const g = generic(t);
      return g && g.name === 'Option' && g.args.length === 1
        ? `${ctx.describe(g.args[0]!)}, or nothing`
        : null;
    },
  },
  {
    name: 'promise',
    apply: (t, ctx) => {
      const g = generic(t);
      return g && g.name === 'Promise' && g.args.length === 1
        ? `(eventually) ${ctx.describe(g.args[0]!)}`
        : null;
    },
  },
  {
    name: 'result',
    apply: (t, ctx) => {
      const g = generic(t);
      return g && /Result$/.test(g.name) && g.args.length >= 1
        ? `${ctx.describe(g.args[0]!)}, or an error`
        : null;
    },
  },
  {
    name: 'object type',
    apply: (t, ctx) => {
      if (!/^\{.*\}$/.test(t)) {
        return null;
      }
      const fields = objectFields(t.slice(1, -1));
      return fields.length === 0 ? 'an object' : spellFields(fields, ctx.describe);
    },
  },
  {
    name: 'tuple',
    apply: (t, ctx) => {
      const tuple = /^\[(.+)\]$/.exec(t) ?? (ctx.lang === 'rust' ? /^\((.+)\)$/.exec(t) : null);
      if (!tuple) {
        return null;
      }
      const parts = splitTop(tuple[1]!, ',');
      return parts.length < 2 ? null : joinList(parts.map(ctx.describe));
    },
  },
  {
    name: 'named struct (resolved)',
    apply: (t, ctx) => {
      const fields = ctx.resolve?.(t) ?? null;
      return fields && fields.length > 0 ? spellFields(fields, ctx.describe) : null;
    },
  },
  { name: 'own name', apply: (t) => `\`${t}\`` },
];

/* ---- public API -------------------------------------------------------------- */

/** The phrase for a type, from {@link TYPE_RULES} (first matching row wins). */
export function describeType(
  typeText: string,
  lang: CodeLanguage = 'ts',
  resolve?: FieldResolver,
): string {
  const t = normalizeType(typeText);
  if (t === '') {
    return 'nothing';
  }
  const ctx: TypeContext = {
    lang,
    describe: (inner) => describeType(inner, lang, resolve),
    resolve,
  };
  for (const rule of TYPE_RULES) {
    const phrase = rule.apply(t, ctx);
    if (phrase !== null) {
      return phrase;
    }
  }
  return `\`${t}\``;
}

/**
 * The phrase for one parameter: the author's `@param` text when given, else
 * the name rules, else the type. Optional / default / rest / `&mut` add words.
 */
export function describeParam(
  param: Param,
  docParam?: string | null,
  lang: CodeLanguage = 'ts',
  resolve?: FieldResolver,
): string {
  let phrase =
    docParam?.trim().replace(/\.$/, '') ||
    phraseForName(param.name, param.type, lang, resolve) ||
    (param.type ? describeType(param.type, lang, resolve) : 'something');
  if (param.rest && !docParam) {
    // `...dirs: string[]` — phrase the ELEMENT, then count it.
    const elem = param.type ? (listElement(param.type) ?? param.type) : null;
    const words = splitWords(param.name);
    const row = ruleForHead(singularize(words[words.length - 1] ?? ''), words);
    phrase = `any number of ${row ? row.plural : plural(elem ? describeType(elem, lang, resolve) : 'something')}`;
  }
  if (param.optional || param.hasDefault) {
    phrase = `an optional ${noArticle(phrase)}`;
  }
  if (param.ref === 'mut') {
    phrase = `${phrase} (and may change it)`;
  }
  return phrase;
}

/**
 * The sentence for a unit. Functions and methods follow the template; other
 * kinds get a one-liner of the same flavour (what a struct holds, what an
 * enum is one of, what an impl offers). `model`-level knowledge is passed as
 * `resolve`, so a Rust function returning a struct declared in the same file
 * is spelled field by field too.
 */
export function describeUnit(
  unit: CodeUnit,
  opts: { lang?: CodeLanguage; resolve?: FieldResolver } = {},
): string {
  const lang = opts.lang ?? 'ts';
  const resolve = opts.resolve;
  const name = unit.name;
  switch (unit.kind) {
    case 'function':
    case 'method':
      return functionSentence(unit, lang, resolve);
    case 'struct':
    case 'interface':
    case 'class':
    case 'type': {
      const parts: string[] = [];
      if (unit.fields.length > 0) {
        parts.push(`holds ${spellFields(unit.fields, (t) => describeType(t, lang, resolve))}`);
      }
      if (unit.children.length > 0) {
        parts.push(`offers ${joinList(unit.children.map((c) => c.name))}`);
      }
      if (parts.length === 0 && unit.kind === 'type' && unit.returns) {
        parts.push(`means ${describeType(unit.returns.text, lang, resolve)}`);
      }
      return parts.length > 0 ? `${name} ${parts.join(', and ')}.` : `${name} is a ${unit.kind}.`;
    }
    case 'enum':
      return unit.fields.length > 0
        ? `${name} is one of ${joinList(
            unit.fields.map((f) => f.name),
            'or',
          )}.`
        : `${name} is an empty enum.`;
    case 'impl':
    case 'trait':
    case 'module':
      return unit.children.length > 0
        ? `${name} offers ${joinList(unit.children.map((c) => c.name))}.`
        : `${name} offers nothing.`;
    case 'const':
      return unit.returns
        ? `${name} is ${describeType(unit.returns.text, lang, resolve)}.`
        : `${name} is a fixed value.`;
    default:
      return `${name} is a ${unit.kind}.`;
  }
}

/** `@param name text` lines of a doc comment, keyed by name. */
export function docParams(doc: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!doc) {
    return out;
  }
  for (const line of doc.split('\n')) {
    const m = /^\s*@param\s+(?:\{[^}]*\}\s*)?\[?([\w$]+)\]?\s*[-–:]?\s*(.*)$/.exec(line);
    if (m && m[2]) {
      out.set(m[1]!, m[2].trim());
    }
  }
  return out;
}

/** "a, b, and c" — Oxford comma from three items on. */
export function joinList(items: readonly string[], conjunction = 'and'): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }
  if (items.length === 2) {
    return `${items[0]} ${conjunction} ${items[1]}`;
  }
  return `${items.slice(0, -1).join(', ')}, ${conjunction} ${items[items.length - 1]}`;
}

/* ---- sentence pieces ---------------------------------------------------------- */

function functionSentence(unit: CodeUnit, lang: CodeLanguage, resolve?: FieldResolver): string {
  const docs = docParams(unit.doc);
  const params = unit.params.filter((p) => p.name !== 'self');
  const takes =
    params.length === 0
      ? 'nothing'
      : joinList(params.map((p) => describeParam(p, docs.get(p.name), lang, resolve)));
  const gives = returnPhrase(unit.returns, unit.async, lang, resolve);
  if (gives === null) {
    return `${unit.name} takes ${takes}.`;
  }
  return `${unit.name} takes ${takes}, and ${gives}.`;
}

/** "gives back X" / "eventually gives back X"; null when nothing is known. */
function returnPhrase(
  returns: TypeRef | null,
  async: boolean,
  lang: CodeLanguage,
  resolve?: FieldResolver,
): string | null {
  const verb = async ? 'eventually gives back' : 'gives back';
  if (returns === null) {
    // A Rust fn without `->` returns unit; an unannotated TS function is
    // unknown, and a guess would be worse than silence.
    return lang === 'rust' ? `${verb} nothing` : async ? `${verb} nothing` : null;
  }
  if (returns.fields && returns.fields.length > 0) {
    return `${verb} ${spellFields(returns.fields, (t) => describeType(t, lang, resolve))}`;
  }
  let type = normalizeType(returns.text);
  const g = generic(type);
  if (async && g && g.name === 'Promise' && g.args.length === 1) {
    type = g.args[0]!;
  }
  return `${verb} ${describeType(type, lang, resolve)}`;
}

function phraseForName(
  name: string,
  type: string | null,
  lang: CodeLanguage,
  resolve?: FieldResolver,
): string | null {
  const words = splitWords(name);
  const head = words[words.length - 1];
  const first = words[0];
  if (!head || !first) {
    return null;
  }
  if (words.length > 1 && BOOLEAN_PREFIXES.includes(first)) {
    return 'yes or no';
  }
  if (words.length > 1 && HANDLER_PREFIXES.includes(first)) {
    return 'something to run';
  }
  const row = ruleForHead(head, words);
  if (row) {
    return row.phrase;
  }
  if (LIST_HEADS.includes(head)) {
    return `a list of ${elementsPhrase(type, lang, resolve)}`;
  }
  const singular = singularize(head);
  if (singular !== head) {
    const single = ruleForHead(singular, words);
    if (single) {
      return `a list of ${single.plural}`;
    }
    if (type && listElement(type) === null) {
      // A plural name on a non-list type: the name still wins.
      return `a list of ${plural(describeType(type, lang, resolve))}`;
    }
  }
  return null;
}

/** The element type of a list-shaped type (`T[]`, `Vec<T>`, `&[T]`), or null. */
function listElement(type: string): string | null {
  const t = normalizeType(type);
  return arrayElement(t) ?? listGenericArg(t);
}

function ruleForHead(head: string, words: readonly string[]): NameRule | null {
  // `filePath` is a file path, not a folder — the compound wins over the head.
  if (head === 'path' && words.includes('file')) {
    return NAME_RULES.find((r) => r.heads.includes('filepath')) ?? null;
  }
  return NAME_RULES.find((r) => r.heads.includes(head)) ?? null;
}

function elementsPhrase(type: string | null, lang: CodeLanguage, resolve?: FieldResolver): string {
  const elem = type ? listElement(type) : null;
  return elem ? plural(describeType(elem, lang, resolve)) : 'things';
}

function spellFields(fields: readonly Field[], describe: (t: string) => string): string {
  return joinList(fields.map((f) => `*${f.name}* (${f.type ? describe(f.type) : 'something'})`));
}

/* ---- word and type helpers ------------------------------------------------------ */

/** `shownDirs` → ['shown', 'dirs']; `mtime_ms` → ['mtime', 'ms']. */
export function splitWords(name: string): string[] {
  return name
    .replace(/^[_$]+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function singularize(word: string): string {
  if (word.endsWith('ies') && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 2) {
    return word.slice(0, -1);
  }
  return word;
}

/** "a number" → "numbers"; "text" → "text"; "`Foo`" → "`Foo`". */
export function plural(phrase: string): string {
  const bare = noArticle(phrase);
  const fixed: Record<string, string> = {
    number: 'numbers',
    'something to run': 'things to run',
    something: 'things',
    'yes or no': 'yes or no',
    text: 'text',
    anything: 'anything',
    nothing: 'nothing',
    object: 'objects',
    id: 'ids',
  };
  if (fixed[bare]) {
    return fixed[bare];
  }
  if (bare.startsWith('list of ')) {
    return `lists of ${bare.slice(8)}`;
  }
  if (bare.startsWith('lookup of ')) {
    return `lookups of ${bare.slice(10)}`;
  }
  if (bare.startsWith('`') || /[,()]/.test(bare) || / or /.test(bare)) {
    return bare;
  }
  return bare.endsWith('s') ? bare : `${bare}s`;
}

function noArticle(phrase: string): string {
  return phrase.replace(/^an? /, '');
}

function normalizeType(type: string): string {
  let t = type.replace(/\s+/g, ' ').trim();
  // Borrow and readonly markers are noise for a reader: `&mut` is reported
  // by the param rule instead.
  for (;;) {
    const next = t
      .replace(/^readonly /, '')
      .replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '')
      .replace(/^mut /, '')
      .trim();
    if (next === t) {
      break;
    }
    t = next;
  }
  // `(A | B)` → `A | B`; a bare parenthesised type is just grouping.
  if (t.startsWith('(') && t.endsWith(')') && splitTop(t.slice(1, -1), ',').length === 1) {
    const inner = t.slice(1, -1).trim();
    if (inner !== '' && !/^\(.*\)\s*=>/.test(t)) {
      return normalizeType(inner);
    }
  }
  return t;
}

/** Split on a separator at bracket depth 0 (quotes and `=>` respected). */
export function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      cur += ch;
      continue;
    }
    if ((ch === '=' || ch === '-') && text[i + 1] === '>') {
      cur += `${ch}>`;
      i += 1;
      continue;
    }
    if ('([{<'.includes(ch)) {
      depth += 1;
    } else if (')]}>'.includes(ch)) {
      depth -= 1;
    }
    if (ch === sep && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== '');
}

/** `Name<a, b>` → { name, args }, when the `<…>` closes at the very end. */
function generic(t: string): { name: string; args: string[] } | null {
  const m = /^([\w:.]+)</.exec(t);
  if (!m || !t.endsWith('>')) {
    return null;
  }
  const inner = t.slice(m[0].length, -1);
  // The opening `<` must pair with the final `>`: no top-level close before.
  let depth = 1;
  for (const ch of inner) {
    if ('([{<'.includes(ch)) {
      depth += 1;
    } else if (')]}>'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        return null;
      }
    }
  }
  return { name: m[1]!, args: splitTop(inner, ',') };
}

/** `T[]` → `T` when the brackets are the outermost construct. */
function arrayElement(t: string): string | null {
  if (!t.endsWith('[]') || splitTop(t, '|').length > 1) {
    return null;
  }
  const inner = t.slice(0, -2).trim();
  return inner === '' ? null : inner;
}

function listGenericArg(t: string): string | null {
  const g = generic(t);
  if (g && LIST_GENERICS.test(g.name) && g.args.length === 1) {
    return g.args[0]!;
  }
  const slice = /^\[(.+?)(?:;\s*[^;\]]+)?\]$/.exec(t);
  return slice ? slice[1]! : null;
}

/** `a: T; b?: U` → fields (types kept raw). */
function objectFields(inner: string): Field[] {
  const members = splitTop(inner, ';').flatMap((p) => splitTop(p, ','));
  const out: Field[] = [];
  for (const m of members) {
    const colon = splitTop(m, ':');
    if (colon.length < 2) {
      continue;
    }
    const rawName = colon[0]!.replace(/^readonly /, '').trim();
    out.push({
      name: rawName.replace(/\?$/, ''),
      type: colon.slice(1).join(':').trim(),
      optional: rawName.endsWith('?'),
      doc: null,
      line: 0,
    });
  }
  return out;
}
