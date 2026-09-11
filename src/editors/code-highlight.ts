/**
 * TypeScript / JavaScript and Rust highlighting for Raw mode — the "zero extra
 * cost" half of taking the Lezer grammars for the code Review model
 * (core/code): the same parsers, wrapped in `LRLanguage.define`, give the
 * source editor real syntax colouring. Both grammars ship their own
 * `styleTags`, so no tag mapping lives here.
 *
 * Like `markdown-highlight.ts` and `xml-highlight.ts`, every colour is a CSS
 * variable from base.css in the `--md-*` vocabulary, so light/dark and every
 * theme plugin work with no code here: keywords → accent, names being defined
 * and called → heading colour, types → link colour, strings and numbers →
 * code colour, comments → quote colour.
 */

import { HighlightStyle, LRLanguage } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { parser as jsParser } from '@lezer/javascript';
import { parser as rustParser } from '@lezer/rust';

/** One TypeScript language for every `.ts/.tsx/.js/.jsx` file (JSX allowed). */
export const tsLanguage = LRLanguage.define({
  name: 'typescript',
  parser: jsParser.configure({ dialect: 'ts jsx' }),
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export const rustLanguage = LRLanguage.define({
  name: 'rust',
  parser: rustParser,
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});

export const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--accent)' },
  {
    tag: [tags.string, tags.special(tags.string), tags.regexp],
    color: 'var(--md-code, var(--fg-muted))',
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--md-code, var(--fg-muted))' },
  { tag: tags.comment, fontStyle: 'italic', color: 'var(--md-quote, var(--fg-muted))' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--md-link, var(--accent))' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
    ],
    color: 'var(--md-heading, var(--fg))',
  },
  { tag: [tags.meta, tags.annotation, tags.operator, tags.macroName], color: 'var(--fg-muted)' },
]);
