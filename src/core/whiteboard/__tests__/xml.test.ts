import { describe, expect, it } from 'vitest';
import {
  attr,
  childElements,
  decodeEntities,
  escapeAttr,
  escapeText,
  isBlankText,
  localName,
  numAttr,
  parseXml,
  rawSource,
  textContent,
  XmlError,
  type XmlElement,
} from '../xml';

describe('parseXml', () => {
  it('reads elements, attributes and nesting', () => {
    const source = '<svg width="10"><g id="a"><path d="M0 0"/></g></svg>';
    const { root } = parseXml(source);
    expect(root.name).toBe('svg');
    expect(attr(root, 'width')).toBe('10');
    const g = childElements(root)[0]!;
    expect(g.name).toBe('g');
    expect(childElements(g)[0]!.name).toBe('path');
  });

  it('accepts single quotes, self-closing tags and whitespace in tags', () => {
    const { root } = parseXml('<svg  a = \'one\'\n b="two" />');
    expect(attr(root, 'a')).toBe('one');
    expect(attr(root, 'b')).toBe('two');
    expect(root.children).toEqual([]);
  });

  it('keeps the prologue and epilogue as nodes rather than dropping them', () => {
    const source = '<?xml version="1.0"?>\n<!-- lead -->\n<svg/>\n<!-- trail -->\n';
    const doc = parseXml(source);
    expect(doc.prologue.map((n) => n.type)).toEqual(['pi', 'text', 'comment', 'text']);
    expect(doc.epilogue.some((n) => n.type === 'comment')).toBe(true);
    expect(rawSource(source, doc.prologue[2]!)).toBe('<!-- lead -->');
  });

  it('handles comments, CDATA and a bracketed DOCTYPE', () => {
    const source = '<!DOCTYPE svg [<!ENTITY x "y>">]><svg><!--c--><t><![CDATA[a<b]]></t></svg>';
    const doc = parseXml(source);
    expect(doc.prologue).toHaveLength(1);
    expect(doc.prologue[0]!.type).toBe('doctype');
    expect(textContent(source, doc.root)).toBe('a<b');
  });

  it('gives exact source spans, which is what verbatim re-emission needs', () => {
    const source = '<svg>  <defs><style>a{}</style></defs></svg>';
    const { root } = parseXml(source);
    const defs = childElements(root)[0]!;
    expect(rawSource(source, defs)).toBe('<defs><style>a{}</style></defs>');
  });

  it('skips a byte-order mark without shifting offsets', () => {
    const source = '\ufeff<svg id="x"/>';
    const { root } = parseXml(source);
    expect(root.start).toBe(1);
    expect(rawSource(source, root)).toBe('<svg id="x"/>');
  });

  it.each([
    ['<svg><g></svg>', 'mismatched closing tag'],
    ['<svg>', 'unclosed root'],
    ['<svg a/>', 'attribute without a value'],
    ['<svg a=b/>', 'unquoted attribute value'],
    ['<svg/><svg/>', 'two roots'],
    ['   ', 'no root element'],
    ['<svg><!-- unterminated</svg>', 'unterminated comment'],
  ])('rejects malformed XML: %s (%s)', (source) => {
    expect(() => parseXml(source)).toThrow(XmlError);
  });
});

describe('entities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'a & b <c> "d" \'e\'',
    );
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
  });

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(decodeEntities('&nbsp;')).toBe('&nbsp;');
  });

  it('round-trips through the escapers', () => {
    const value = 'a & b < c > d "e"';
    expect(decodeEntities(escapeAttr(value))).toBe(value);
    expect(decodeEntities(escapeText(value))).toBe(value);
  });

  it('decodes attribute values at parse time', () => {
    const { root } = parseXml('<svg title="a &amp; b"/>');
    expect(attr(root, 'title')).toBe('a & b');
  });
});

describe('helpers', () => {
  const source = '<svg xmlns:wb="u" wb:layer="a1" other="x"> <g/>text</svg>';
  const root: XmlElement = parseXml(source).root;

  it('strips namespace prefixes for localName', () => {
    expect(localName('wb:layer')).toBe('layer');
    expect(localName('g')).toBe('g');
  });

  it('matches an attribute by qualified name, then by local name', () => {
    expect(attr(root, 'wb:layer')).toBe('a1');
    expect(attr(root, 'layer')).toBe('a1');
    expect(attr(root, 'missing')).toBe(null);
  });

  it('parses numeric attributes with a fallback', () => {
    expect(numAttr(root, 'other', 7)).toBe(7); // 'x' is not a number
    expect(numAttr(root, 'nope', 3)).toBe(3);
    expect(numAttr(parseXml('<svg width="12.5"/>').root, 'width', 0)).toBe(12.5);
  });

  it('identifies whitespace-only text nodes', () => {
    const [space, , text] = root.children;
    expect(isBlankText(source, space!)).toBe(true);
    expect(isBlankText(source, text!)).toBe(false);
  });
});
