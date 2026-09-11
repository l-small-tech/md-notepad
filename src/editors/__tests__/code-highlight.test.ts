import { describe, expect, test } from 'vitest';
import { highlightTree, tags } from '@lezer/highlight';
import { codeHighlightStyle, rustLanguage, tsLanguage } from '../code-highlight';

/** Highlight `doc` with a language's parser; returns the coloured spans. */
function highlight(language: typeof tsLanguage, doc: string): { text: string; classes: string }[] {
  const tree = language.parser.parse(doc);
  const spans: { text: string; classes: string }[] = [];
  highlightTree(tree, codeHighlightStyle, (from, to, classes) => {
    spans.push({ text: doc.slice(from, to), classes });
  });
  return spans;
}

const classOf = (spans: ReturnType<typeof highlight>, text: string) =>
  spans.find((s) => s.text === text)?.classes ?? null;

describe('raw-mode code highlighting', () => {
  const keyword = codeHighlightStyle.style([tags.keyword])!;
  const comment = codeHighlightStyle.style([tags.comment])!;
  const string = codeHighlightStyle.style([tags.string])!;
  const typeName = codeHighlightStyle.style([tags.typeName])!;

  test('TypeScript: keywords, strings, comments, types and definitions are coloured', () => {
    const spans = highlight(
      tsLanguage,
      "// note\nexport function f(a: string): boolean { return a === 'x'; }\n",
    );
    expect(classOf(spans, 'export')).toBe(keyword);
    expect(classOf(spans, 'function')).toBe(keyword);
    expect(classOf(spans, '// note')).toBe(comment);
    expect(classOf(spans, "'x'")).toBe(string);
    expect(classOf(spans, 'string')).toBe(typeName);
    expect(classOf(spans, 'f')).toBe(
      codeHighlightStyle.style([tags.function(tags.definition(tags.variableName))]),
    );
  });

  test('TypeScript language accepts JSX without parse errors', () => {
    const tree = tsLanguage.parser.parse('const x = <div a="1">hi</div>;');
    let errors = 0;
    tree.iterate({
      enter: (n) => {
        if (n.type.isError) {
          errors += 1;
        }
      },
    });
    expect(errors).toBe(0);
  });

  test('Rust: keywords, doc comments, strings and types are coloured', () => {
    const spans = highlight(
      rustLanguage,
      '/// doc\npub fn f(p: &Path) -> bool { p.ends_with("x") }\n',
    );
    expect(classOf(spans, 'pub')).toBe(keyword);
    expect(classOf(spans, 'fn')).toBe(keyword);
    expect(classOf(spans, '/// doc')).toBe(comment);
    expect(classOf(spans, '"x"')).toBe(string);
    expect(classOf(spans, 'Path')).toBe(typeName);
  });
});
