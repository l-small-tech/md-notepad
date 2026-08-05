/**
 * A tiny, pure XML reader for the whiteboard format.
 *
 * Why not DOMParser? Two reasons, both load-bearing:
 *
 * 1. `src/core` is DOM-free (invariant I9), and parse/serialize are the
 *    golden-tested heart of the file format — they must run in the node test
 *    env with no shims.
 * 2. The round-trip guarantee "nothing is ever dropped" needs **source spans**.
 *    Content we don't model (an Inkscape `<sodipodi:namedview>`, a hand-authored
 *    `<filter>`, a comment) is re-emitted by slicing the ORIGINAL text, which
 *    XMLSerializer cannot give us — it re-formats.
 *
 * Scope is deliberately the XML subset SVG files actually use: elements,
 * attributes, text, comments, CDATA, processing instructions and DOCTYPE.
 * Namespaces are treated as part of the qualified name (`wb:layer` is just a
 * name) — the whiteboard format pins its prefixes, and foreign content is
 * re-emitted verbatim anyway, so prefix resolution buys nothing.
 *
 * Anything malformed throws {@link XmlError}; the adapter turns that into the
 * "open as text" error card rather than guessing at broken markup.
 */

export interface XmlAttr {
  readonly name: string;
  /** Entity-decoded value. */
  readonly value: string;
}

export interface XmlElement {
  readonly type: 'element';
  /** Qualified name exactly as authored, e.g. `g`, `wb:doc`. */
  readonly name: string;
  readonly attrs: readonly XmlAttr[];
  readonly children: readonly XmlNode[];
  /** Source offsets covering the whole element, `[start, end)`. */
  readonly start: number;
  readonly end: number;
}

/** Everything that is not an element. Carried purely so it can be re-emitted. */
export interface XmlOther {
  readonly type: 'text' | 'comment' | 'pi' | 'doctype' | 'cdata';
  readonly start: number;
  readonly end: number;
}

export type XmlNode = XmlElement | XmlOther;

export interface XmlDocument {
  /** Nodes before the root element (xml declaration, doctype, comments). */
  readonly prologue: readonly XmlNode[];
  readonly root: XmlElement;
  /** Nodes after the root element (trailing comments/whitespace). */
  readonly epilogue: readonly XmlNode[];
}

export class XmlError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'XmlError';
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9_:.]/;
const SPACE = /\s/;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolve the five XML entities plus numeric character references. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** Escape for use inside a double-quoted attribute value. */
export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Escape for use as element text content. */
export function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function parseXml(source: string): XmlDocument {
  // Strip a BOM by starting past it; offsets stay valid against `source`.
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  function fail(message: string, at: number = i): never {
    throw new XmlError(message, at);
  }

  function skipSpace(): void {
    while (i < source.length && SPACE.test(source[i]!)) {
      i++;
    }
  }

  function readName(): string {
    const start = i;
    if (i >= source.length || !NAME_START.test(source[i]!)) {
      fail('expected an element or attribute name');
    }
    i++;
    while (i < source.length && NAME_CHAR.test(source[i]!)) {
      i++;
    }
    return source.slice(start, i);
  }

  /** Consume `<prefix … terminator>`; `skip` is the opener length. */
  function readDelimited(type: XmlOther['type'], skip: number, terminator: string): XmlOther {
    const start = i;
    const at = source.indexOf(terminator, i + skip);
    if (at < 0) {
      fail(`unterminated ${type}`, start);
    }
    i = at + terminator.length;
    return { type, start, end: i };
  }

  /** DOCTYPE needs bracket awareness: an internal subset may contain `>`. */
  function readDoctype(): XmlOther {
    const start = i;
    i += '<!DOCTYPE'.length;
    let depth = 0;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '[') {
        depth++;
      } else if (ch === ']') {
        depth--;
      } else if (ch === '>' && depth <= 0) {
        i++;
        return { type: 'doctype', start, end: i };
      }
      i++;
    }
    return fail('unterminated doctype', start);
  }

  function parseElement(): XmlElement {
    const start = i;
    i++; // '<'
    const name = readName();
    const attrs: XmlAttr[] = [];
    for (;;) {
      skipSpace();
      const ch = source[i];
      if (ch === undefined) {
        fail(`unterminated start tag <${name}>`, start);
      }
      if (ch === '>') {
        i++;
        break;
      }
      if (ch === '/') {
        if (source[i + 1] !== '>') {
          fail(`expected "/>" in <${name}>`);
        }
        i += 2;
        return { type: 'element', name, attrs, children: [], start, end: i };
      }
      const attrName = readName();
      skipSpace();
      if (source[i] !== '=') {
        fail(`attribute "${attrName}" has no value`);
      }
      i++;
      skipSpace();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") {
        fail(`attribute "${attrName}" value is not quoted`);
      }
      i++;
      const valueStart = i;
      const close = source.indexOf(quote, i);
      if (close < 0) {
        fail(`unterminated value for attribute "${attrName}"`, valueStart);
      }
      i = close + 1;
      attrs.push({ name: attrName, value: decodeEntities(source.slice(valueStart, close)) });
    }
    const children = parseChildren(name, start);
    return { type: 'element', name, attrs, children, start, end: i };
  }

  function parseChildren(parentName: string, parentStart: number): XmlNode[] {
    const children: XmlNode[] = [];
    for (;;) {
      if (i >= source.length) {
        fail(`unclosed <${parentName}>`, parentStart);
      }
      if (source.startsWith('</', i)) {
        const closeStart = i;
        i += 2;
        const closeName = readName();
        skipSpace();
        if (source[i] !== '>') {
          fail(`malformed closing tag for <${parentName}>`, closeStart);
        }
        i++;
        if (closeName !== parentName) {
          fail(`</${closeName}> closes <${parentName}>`, closeStart);
        }
        return children;
      }
      children.push(parseNode());
    }
  }

  function parseNode(): XmlNode {
    if (source[i] !== '<') {
      const start = i;
      const next = source.indexOf('<', i);
      i = next < 0 ? source.length : next;
      return { type: 'text', start, end: i };
    }
    if (source.startsWith('<!--', i)) {
      return readDelimited('comment', 4, '-->');
    }
    if (source.startsWith('<![CDATA[', i)) {
      return readDelimited('cdata', 9, ']]>');
    }
    if (source.startsWith('<!DOCTYPE', i)) {
      return readDoctype();
    }
    if (source.startsWith('<?', i)) {
      return readDelimited('pi', 2, '?>');
    }
    if (source.startsWith('</', i)) {
      fail('unexpected closing tag');
    }
    return parseElement();
  }

  const prologue: XmlNode[] = [];
  const epilogue: XmlNode[] = [];
  let root: XmlElement | null = null;
  while (i < source.length) {
    const node = parseNode();
    if (node.type === 'element') {
      if (root) {
        fail('more than one root element', node.start);
      }
      root = node;
    } else if (root) {
      epilogue.push(node);
    } else {
      prologue.push(node);
    }
  }
  if (!root) {
    throw new XmlError('no root element', 0);
  }
  return { prologue, root, epilogue };
}

/* ---------------------------------- helpers ---------------------------------- */

/** The name without its namespace prefix (`wb:layer` → `layer`). */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

export function attr(element: XmlElement, name: string): string | null {
  // Match on the qualified name first, then fall back to the local name so a
  // file authored with a different prefix for the same concept still reads.
  const exact = element.attrs.find((a) => a.name === name);
  if (exact) {
    return exact.value;
  }
  const local = localName(name);
  const loose = element.attrs.find((a) => localName(a.name) === local);
  return loose ? loose.value : null;
}

export function numAttr(element: XmlElement, name: string, fallback: number): number {
  const raw = attr(element, name);
  if (raw === null) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((c): c is XmlElement => c.type === 'element');
}

/** The element's decoded text content (direct text children only). */
export function textContent(source: string, element: XmlElement): string {
  let out = '';
  for (const child of element.children) {
    if (child.type === 'text') {
      out += decodeEntities(source.slice(child.start, child.end));
    } else if (child.type === 'cdata') {
      out += source.slice(child.start + 9, child.end - 3);
    } else if (child.type === 'element') {
      out += textContent(source, child);
    }
  }
  return out;
}

/** The node's ORIGINAL source text — the verbatim re-emission primitive. */
export function rawSource(source: string, node: XmlNode): string {
  return source.slice(node.start, node.end);
}

export function isBlankText(source: string, node: XmlNode): boolean {
  return node.type === 'text' && source.slice(node.start, node.end).trim() === '';
}
