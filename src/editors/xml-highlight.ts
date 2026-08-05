/**
 * XML/SVG syntax highlighting for raw mode, so a whiteboard's source is
 * readable when you open it as text (`Raw` on an `.svg` tab).
 *
 * Hand-rolled as a CM6 `StreamLanguage` rather than taking `@codemirror/lang-xml`:
 * the project freezes dependencies, and a highlighter — unlike a full parser —
 * only needs to tokenize, which is ~70 lines. There is no folding, no
 * indentation service and no error recovery here on purpose; if any of those is
 * ever wanted, THAT is the moment to take the real package.
 *
 * Like `markdown-highlight.ts`, every color is a CSS variable from base.css, so
 * light/dark and every theme plugin work with no code here at all. The tags
 * reuse the same `--md-*` vocabulary the markdown style and the Read pane use,
 * so the two modes stay visually of a piece:
 *   tag names → heading color, attribute names → link/accent, values → code.
 */

import { HighlightStyle, StreamLanguage, type StreamParser } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** Where the tokenizer is when a token spans lines (comments, CDATA, tags). */
interface XmlState {
  inTag: boolean;
  /** Set while consuming a `<!-- … -->`, `<![CDATA[ … ]]>` or `<? … ?>` run. */
  block: 'comment' | 'cdata' | 'pi' | null;
  /** Inside a tag: the next name token is an attribute name, not the element. */
  sawName: boolean;
}

const NAME = /[-A-Za-z0-9_:.]/;

/** Exported for its unit test, which drives it with a bare `StringStream`. */
export const xmlParser: StreamParser<XmlState> = {
  name: 'xml',

  startState: () => ({ inTag: false, block: null, sawName: false }),

  token(stream, state) {
    // --- multi-line blocks first: they swallow everything until their close ---
    if (state.block !== null) {
      const terminator = state.block === 'comment' ? '-->' : state.block === 'cdata' ? ']]>' : '?>';
      const style = state.block === 'cdata' ? 'string' : 'comment';
      if (stream.skipTo(terminator)) {
        stream.match(terminator);
        state.block = null;
      } else {
        stream.skipToEnd();
      }
      return style;
    }

    if (stream.match('<!--')) {
      state.block = 'comment';
      return 'comment';
    }
    if (stream.match('<![CDATA[')) {
      state.block = 'cdata';
      return 'string';
    }
    if (stream.match('<?')) {
      state.block = 'pi';
      return 'comment';
    }
    if (stream.match('<!')) {
      // DOCTYPE and friends — one line is plenty for the files we open.
      stream.skipToEnd();
      return 'comment';
    }

    // --- tag punctuation -----------------------------------------------------
    if (!state.inTag && stream.match(/^<\/?/)) {
      state.inTag = true;
      state.sawName = false;
      return 'angleBracket';
    }
    if (state.inTag && stream.match(/^\/?>/)) {
      state.inTag = false;
      return 'angleBracket';
    }

    // --- text between tags ---------------------------------------------------
    if (!state.inTag) {
      // An entity is worth calling out; everything else is plain content.
      if (stream.match(/^&(?:#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/)) {
        return 'escape';
      }
      stream.next();
      stream.eatWhile(/[^<&]/);
      return null;
    }

    // --- inside a tag --------------------------------------------------------
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match(/^"[^"]*"?/) || stream.match(/^'[^']*'?/)) {
      return 'attributeValue';
    }
    if (stream.eat('=')) {
      return null;
    }
    if (NAME.test(stream.peek() ?? '')) {
      stream.eatWhile(NAME);
      // The first name in a tag is the element; every later one is an attribute.
      if (state.sawName) {
        return 'attributeName';
      }
      state.sawName = true;
      return 'tagName';
    }

    stream.next();
    return null;
  },

  tokenTable: {
    angleBracket: tags.angleBracket,
    tagName: tags.tagName,
    attributeName: tags.attributeName,
    attributeValue: tags.attributeValue,
    comment: tags.comment,
    string: tags.string,
    escape: tags.escape,
  },
};

export const xmlLanguage = StreamLanguage.define(xmlParser);

export const xmlHighlightStyle = HighlightStyle.define([
  { tag: tags.tagName, fontWeight: 'bold', color: 'var(--md-heading, var(--fg))' },
  { tag: tags.attributeName, color: 'var(--md-link, var(--accent))' },
  { tag: tags.attributeValue, color: 'var(--md-code, var(--fg-muted))' },
  { tag: tags.angleBracket, color: 'var(--fg-muted)' },
  { tag: tags.comment, fontStyle: 'italic', color: 'var(--md-quote, var(--fg-muted))' },
  { tag: tags.string, color: 'var(--md-code, var(--fg-muted))' },
  { tag: tags.escape, color: 'var(--md-bold, var(--fg))' },
]);
