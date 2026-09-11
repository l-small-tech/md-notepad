import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { flowGraph } from '../flow';
import {
  CALL_GRAPH_FOCUS_AT,
  callGraphMermaid,
  escapeLabel,
  flowMermaid,
  kindGlyph,
  safeId,
} from '../mermaid-text';
import { parseCode } from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const textFiles = parseCode(fixture('text-files.ts.txt'), 'src/core/text-files.ts')!;
const fs = parseCode(fixture('fs.rs.txt'), 'fs.rs')!;

describe('callGraphMermaid', () => {
  test('text-files.ts matches the §5.1 diagram: caller → callee, exported bold, heavy units sized', () => {
    const { text, nodes, focused, omitted, total } = callGraphMermaid(textFiles, {
      changed: new Set(['function:showAllFilesState']),
    });
    expect(text).toBe(
      [
        'flowchart TD',
        '  isMarkdownPath["ƒ isMarkdownPath"]',
        '  isEditableTextPath["ƒ isEditableTextPath"]',
        '  dirKey["ƒ dirKey"]',
        '  isAtOrBelow["ƒ isAtOrBelow"]',
        '  showAllFilesState["ƒ showAllFilesState<br/>32 lines"]',
        '  showsAllFiles["ƒ showsAllFiles"]',
        '  toggleShowAllFiles["ƒ toggleShowAllFiles<br/>20 lines"]',
        '  isEditableTextPath --> isMarkdownPath',
        '  isAtOrBelow --> dirKey',
        '  showAllFilesState --> dirKey',
        '  showAllFilesState --> isAtOrBelow',
        '  showsAllFiles --> showAllFilesState',
        '  toggleShowAllFiles --> dirKey',
        '  toggleShowAllFiles --> showsAllFiles',
        '  toggleShowAllFiles --> isAtOrBelow',
        '  classDef exported stroke-width:2px,font-weight:bold',
        '  classDef changed stroke:#d97706,stroke-width:3px',
        '  classDef exportedChanged stroke:#d97706,stroke-width:3px,font-weight:bold',
        '  class isMarkdownPath,isEditableTextPath,showsAllFiles,toggleShowAllFiles exported',
        '  class showAllFilesState exportedChanged',
      ].join('\n'),
    );
    expect(nodes.map((n) => n.unitId)).toContain('function:showAllFilesState');
    expect(focused).toBe(false);
    expect(omitted).toBe(0);
    expect(total).toBe(7);
  });

  test('a changed unit that is not exported gets the plain amber ring', () => {
    const { text } = callGraphMermaid(textFiles, { changed: new Set(['function:dirKey']) });
    expect(text).toContain('\n  class dirKey changed');
  });

  test('fs.rs: methods inside impls are nodes; the trait impl method is exported through the trait', () => {
    const { text } = callGraphMermaid(fs);
    expect(text).toContain('  serialize --> code');
    expect(text).toContain('  is_listed_file --> is_text_path');
    expect(text).toContain('  read_text_file --> not_found_or_io');
    expect(text).toMatch(/class .*serialize.* exported/);
    // No struct / enum nodes: nothing in the file calls them.
    expect(text).not.toContain('PathStat');
  });

  test('focus mode above the threshold keeps exported units and their one-hop neighbours', () => {
    const n = CALL_GRAPH_FOCUS_AT + 5;
    const src = Array.from({ length: n }, (_, i) =>
      i === 0 ? 'export function f0() { f1(); }' : `function f${i}() { f${i + 1 < n ? i + 1 : 0}(); }`,
    ).join('\n');
    const m = parseCode(src, 'x.ts')!;
    const auto = callGraphMermaid(m);
    expect(auto.focused).toBe(true);
    expect(auto.total).toBe(n);
    // f0 (exported), f1 (called by f0) and f{n-1} (calls f0).
    expect(auto.nodes.map((x) => x.id).sort()).toEqual(['f0', 'f1', `f${n - 1}`].sort());
    expect(auto.omitted).toBe(n - 3);
    expect(auto.text).toContain('  f0 --> f1');
    expect(auto.text).not.toContain('  f2 --> f3');

    const full = callGraphMermaid(m, { focus: false });
    expect(full.focused).toBe(false);
    expect(full.nodes).toHaveLength(n);
    expect(callGraphMermaid(textFiles, { focus: true }).focused).toBe(true);
  });

  test('an empty model is still valid mermaid', () => {
    const m = parseCode('const x = 1;', 'x.ts')!;
    const { text, nodes } = callGraphMermaid(m);
    expect(nodes).toEqual([]);
    expect(text.split('\n')[0]).toBe('flowchart TD');
  });
});

describe('flowMermaid', () => {
  test('showAllFilesState matches the §5.2 diagram shape: stadium start/return, subgraph, labelled edges', () => {
    const text = flowMermaid(flowGraph(textFiles.units.find((u) => u.name === 'showAllFilesState')!));
    expect(text).toBe(
      [
        'flowchart TD',
        '  n0(["start"])',
        '  n1["key = dirKey(dir)<br/>best: { len: number; show: boolean; exp…"]',
        '  n7["consider(shownDirs, true)<br/>consider(hiddenDirs, false)"]',
        '  n8(["return { show: best.show, explicit: best.expli…"])',
        '  subgraph sg0["consider (inner)"]',
        '    n2(["for (const d of dirs)"])',
        '    n3["root = dirKey(d)"]',
        '    n4{"root.length #gt; best.len && isAtOrBelow(k…?"}',
        '    n5["best = { len: root.length, show, explic…"]',
        '    n6(["end"])',
        '  end',
        '  n0 --> n1',
        '  n2 --> n3',
        '  n3 --> n4',
        '  n4 -->|"yes"| n5',
        '  n5 --> n2',
        '  n4 -->|"no"| n2',
        '  n2 -->|"done"| n6',
        '  n1 --> n7',
        '  n7 --> n8',
      ].join('\n'),
    );
  });

  test('a switch draws one labelled edge per arm', () => {
    const docFamily = parseCode(fixture('doc-family.ts.txt'), 'doc-family.ts')!;
    const text = flowMermaid(flowGraph(docFamily.units.find((u) => u.name === 'allowedModesFor')!));
    expect(text).toContain('  n1{"family"}');
    expect(text).toContain('  n1 -->|"\'svg\'"| n2');
    expect(text).toContain('  n1 -->|"default"| n5');
  });

  test('labels escape quotes, angle brackets, hashes and pipes with mermaid entity codes', () => {
    const m = parseCode('function f(a: string) { if (a < "#x" || a > "|") { g(); } }', 'x.ts')!;
    const text = flowMermaid(flowGraph(m.units[0]!));
    expect(text).toContain('{"a #lt; #quot;#35;x#quot; #124;#124; a #gt; #quot;#124;#quot;?"}');
  });
});

describe('helpers', () => {
  test('escapeLabel handles # first so entity codes are not double-escaped', () => {
    expect(escapeLabel('a#b"c<d>e|f')).toBe('a#35;b#quot;c#lt;d#gt;e#124;f');
  });

  test('safeId never yields a reserved word, a leading digit or a clash', () => {
    const used = new Set<string>();
    expect(safeId('end', used)).toBe('n_end');
    expect(safeId('2fast', used)).toBe('n_2fast');
    expect(safeId('impl Foo::bar', used)).toBe('impl_Foo_bar');
    expect(safeId('impl Foo::bar', used)).toBe('impl_Foo_bar_2');
    expect(safeId('', used)).toBe('n_');
  });

  test('kindGlyph follows §5', () => {
    expect(['function', 'method'].map((k) => kindGlyph(k as 'function'))).toEqual(['ƒ', 'ƒ']);
    expect(kindGlyph('struct')).toBe('▦');
    expect(kindGlyph('enum')).toBe('◆');
    expect(kindGlyph('class')).toBe('▣');
    expect(kindGlyph('const')).toBe('≡');
    expect(kindGlyph('import')).toBe('▤');
  });
});
