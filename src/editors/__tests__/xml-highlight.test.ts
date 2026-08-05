/**
 * The XML tokenizer, driven directly through a bare `StringStream` — no
 * EditorView, so this runs in the node test env like every other pure suite.
 */

import { StringStream } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { xmlParser } from '../xml-highlight';

type XmlTokenState = ReturnType<NonNullable<typeof xmlParser.startState>>;

function newState(): XmlTokenState {
  const start = xmlParser.startState;
  if (!start) {
    throw new Error('xmlParser must define startState');
  }
  return start(2);
}

/** Tokenize one line, carrying `state` across calls; returns [text, style] pairs. */
function tokenizeLine(
  line: string,
  state: XmlTokenState = newState(),
): { tokens: [string, string | null][]; state: XmlTokenState } {
  const stream = new StringStream(line, 2, 2);
  const tokens: [string, string | null][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = xmlParser.token(stream, state);
    // A tokenizer that consumes nothing would spin forever; catch that here
    // rather than hanging the suite.
    expect(stream.pos).toBeGreaterThan(stream.start);
    tokens.push([line.slice(stream.start, stream.pos), style]);
  }
  return { tokens, state };
}

/** Every non-null style in a single line, in order. */
function styles(line: string): (string | null)[] {
  return tokenizeLine(line).tokens.map(([, style]) => style);
}

/** The text of the first token carrying `style`. */
function firstWith(line: string, style: string): string | undefined {
  return tokenizeLine(line).tokens.find(([, s]) => s === style)?.[0];
}

describe('xml tokenizer', () => {
  it('separates the element name from its attributes', () => {
    const { tokens } = tokenizeLine('<path d="M0 0" stroke="#1a1a1a"/>');
    const named = tokens.filter(([, style]) => style !== null);
    expect(named).toEqual([
      ['<', 'angleBracket'],
      ['path', 'tagName'],
      ['d', 'attributeName'],
      ['"M0 0"', 'attributeValue'],
      ['stroke', 'attributeName'],
      ['"#1a1a1a"', 'attributeValue'],
      ['/>', 'angleBracket'],
    ]);
  });

  it('handles namespaced names, which is the whole wb: format', () => {
    expect(firstWith('<wb:doc wb:layer="a1"/>', 'tagName')).toBe('wb:doc');
    expect(firstWith('<wb:doc wb:layer="a1"/>', 'attributeName')).toBe('wb:layer');
  });

  it('accepts single-quoted values', () => {
    expect(firstWith("<g id='x'/>", 'attributeValue')).toBe("'x'");
  });

  it('treats a closing tag name as a tag name, not an attribute', () => {
    expect(firstWith('</svg>', 'tagName')).toBe('svg');
  });

  it('does not highlight text between tags, but does highlight entities', () => {
    const { tokens } = tokenizeLine('<t>a &amp; b</t>');
    expect(tokens.find(([text]) => text === '&amp;')?.[1]).toBe('escape');
    expect(tokens.find(([text]) => text.includes('a '))?.[1]).toBe(null);
  });

  it('carries a comment across lines until its terminator', () => {
    const first = tokenizeLine('<!-- start');
    expect(first.tokens.every(([, style]) => style === 'comment')).toBe(true);
    const second = tokenizeLine('still comment -->', first.state);
    expect(second.tokens.every(([, style]) => style === 'comment')).toBe(true);
    // After the terminator the tokenizer is back in ordinary content.
    expect(tokenizeLine('<g/>', second.state).tokens[0]).toEqual(['<', 'angleBracket']);
  });

  it('carries CDATA across lines as a string', () => {
    const first = tokenizeLine('<t><![CDATA[a<b');
    expect(first.tokens.at(-1)?.[1]).toBe('string');
    const second = tokenizeLine('c]]></t>', first.state);
    expect(second.tokens[0]?.[1]).toBe('string');
    expect(second.tokens.some(([, style]) => style === 'tagName')).toBe(true);
  });

  it('treats the xml declaration and a doctype as comments', () => {
    expect(styles('<?xml version="1.0"?>').every((s) => s === 'comment')).toBe(true);
    expect(styles('<!DOCTYPE svg>').every((s) => s === 'comment')).toBe(true);
  });

  it('does not stall on an unterminated attribute value', () => {
    // The loop guard in tokenizeLine is the real assertion here.
    expect(styles('<g id="oops').filter((s) => s !== null).length).toBeGreaterThan(0);
  });
});
