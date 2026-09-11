import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FLOW_NODE_CAP, flowGraph, flowHasBranches, type FlowGraph } from '../flow';
import type { CodeUnit } from '../model';
import { parseCode } from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const textFiles = parseCode(fixture('text-files.ts.txt'), 'src/core/text-files.ts')!;
const docFamily = parseCode(fixture('doc-family.ts.txt'), 'doc-family.ts')!;
const fs = parseCode(fixture('fs.rs.txt'), 'fs.rs')!;

function unitOf(model: { units: CodeUnit[] }, name: string): CodeUnit {
  const all = model.units.flatMap((u) => [u, ...u.children]);
  const u = all.find((x) => x.name === name);
  if (!u) {
    throw new Error(`no unit ${name}`);
  }
  return u;
}

/** `from -label-> to` per edge, with node labels instead of ids. */
function edgesOf(g: FlowGraph): string[] {
  const label = (id: string) => g.nodes.find((n) => n.id === id)!.lines.join(' | ');
  return g.edges.map((e) => `${label(e.from)} -${e.label ?? ''}-> ${label(e.to)}`);
}

describe('flowGraph', () => {
  test('showAllFilesState (§5.2): seq boxes, an inner-function subgraph with loop + diamond, a return terminal', () => {
    const g = flowGraph(unitOf(textFiles, 'showAllFilesState'));
    expect(g.truncated).toBe(false);
    expect(g.subgraphs).toEqual([{ id: 'sg0', label: 'consider (inner)' }]);
    const outer = g.nodes.filter((n) => n.subgraph === null);
    expect(outer.map((n) => [n.shape, n.lines])).toEqual([
      ['terminal', ['start']],
      ['box', ['key = dirKey(dir)', 'best: { len: number; show: boolean; exp…']],
      ['box', ['consider(shownDirs, true)', 'consider(hiddenDirs, false)']],
      ['terminal', ['return { show: best.show, explicit: best.expli…']],
    ]);
    const inner = g.nodes.filter((n) => n.subgraph === 'sg0');
    expect(inner.map((n) => n.shape)).toEqual(['loop', 'box', 'diamond', 'box', 'terminal']);
    expect(inner[0]!.lines).toEqual(['for (const d of dirs)']);
    expect(inner[2]!.lines).toEqual(['root.length > best.len && isAtOrBelow(k…?']);
    expect(edgesOf(g)).toEqual([
      'start --> key = dirKey(dir) | best: { len: number; show: boolean; exp…',
      'for (const d of dirs) --> root = dirKey(d)',
      'root = dirKey(d) --> root.length > best.len && isAtOrBelow(k…?',
      'root.length > best.len && isAtOrBelow(k…? -yes-> best = { len: root.length, show, explic…',
      // the loop's back edges: from the branch body and from the "no" side
      'best = { len: root.length, show, explic… --> for (const d of dirs)',
      'root.length > best.len && isAtOrBelow(k…? -no-> for (const d of dirs)',
      'for (const d of dirs) -done-> end',
      'key = dirKey(dir) | best: { len: number; show: boolean; exp… --> consider(shownDirs, true) | consider(hiddenDirs, false)',
      'consider(shownDirs, true) | consider(hiddenDirs, false) --> return { show: best.show, explicit: best.expli…',
    ]);
  });

  test('an if without else joins on the "no" edge; a final return has no end node', () => {
    const g = flowGraph(unitOf(textFiles, 'toggleShowAllFiles'));
    expect(g.nodes.map((n) => n.shape)).toEqual(['terminal', 'box', 'diamond', 'box', 'terminal']);
    expect(edgesOf(g).slice(2)).toEqual([
      'showsAllFiles(dir, shown, hidden) !== w…? -yes-> (want ? shown : hidden).push(dir)',
      '(want ? shown : hidden).push(dir) --> return { shown, hidden }',
      'showsAllFiles(dir, shown, hidden) !== w…? -no-> return { shown, hidden }',
    ]);
    expect(g.nodes.some((n) => n.lines[0] === 'end')).toBe(false);
  });

  test('switch: one labelled edge per arm, each arm ending in its return', () => {
    const g = flowGraph(unitOf(docFamily, 'allowedModesFor'));
    expect(g.nodes[1]).toMatchObject({ shape: 'diamond', lines: ['family'] });
    expect(edgesOf(g)).toEqual([
      'start --> family',
      "family -'svg'-> return SVG_MODES",
      "family -'code'-> return CODE_MODES",
      "family -'terminal'-> return TERMINAL_MODES",
      'family -default-> return MARKDOWN_MODES',
    ]);
  });

  test('a switch without a default keeps an "else" path out', () => {
    const m = parseCode('function f(x: number) { switch (x) { case 1: return 1; } return 0; }', 'x.ts')!;
    const g = flowGraph(m.units[0]!);
    expect(edgesOf(g)).toEqual(['start --> x', 'x -1-> return 1', 'x -else-> return 0']);
  });

  test('Rust: the ? operator is a conditional exit — a terminal plus an "ok" path onward', () => {
    const g = flowGraph(unitOf(fs, 'read_text_file'));
    const edges = edgesOf(g);
    expect(edges[1]).toMatch(/^meta = fs::metadata.* --> on error: return it$/);
    expect(edges[2]).toMatch(/^on error: return it -ok-> bytes = fs::read/);
    // `match` arms are labelled with their patterns.
    expect(edges.some((e) => e.includes("-Ok(text) if !text.contains('\\0')->"))).toBe(true);
    expect(edges.some((e) => e.includes('-_-> return Err('))).toBe(true);
  });

  test('a body-less unit and a plain if/else both behave', () => {
    expect(flowGraph(unitOf(fs, 'PathStat'))).toEqual({
      nodes: [],
      edges: [],
      subgraphs: [],
      truncated: false,
    });
    const g = flowGraph(unitOf(fs, 'not_found_or_io'));
    expect(edgesOf(g)).toEqual([
      'start --> e.kind() == std::io::ErrorKind::NotFound?',
      'e.kind() == std::io::ErrorKind::NotFound? -yes-> FsError::NotFound(path.to_path_buf())',
      'e.kind() == std::io::ErrorKind::NotFound? -no-> FsError::Io(e)',
      'FsError::NotFound(path.to_path_buf()) --> end',
      'FsError::Io(e) --> end',
    ]);
  });

  test('loops: break leaves on the exit path, continue goes back to the head', () => {
    const m = parseCode(
      `function f(xs: number[]) {
  for (const x of xs) {
    if (x < 0) { continue; }
    if (x > 9) { break; }
    use(x);
  }
  done();
}`,
      'x.ts',
    )!;
    const edges = edgesOf(flowGraph(m.units[0]!));
    expect(edges).toContain('x < 0? -yes-> for (const x of xs)');
    expect(edges).toContain('x > 9? -yes-> done()');
    expect(edges).toContain('for (const x of xs) -done-> done()');
    expect(edges).toContain('use(x) --> for (const x of xs)');
  });

  test('try/catch/finally: catch branches off the try body, finally collects every path', () => {
    const m = parseCode(
      `function f() {
  try { risky(); } catch (e) { report(e); } finally { cleanup(); }
  after();
}`,
      'x.ts',
    )!;
    const edges = edgesOf(flowGraph(m.units[0]!));
    expect(edges).toContain('risky() -catch (e)-> report(e)');
    expect(edges).toContain('risky() --> cleanup()');
    expect(edges).toContain('report(e) --> cleanup()');
    expect(edges).toContain('cleanup() --> after()');
  });

  test(`above ${FLOW_NODE_CAP} nodes only depth 1 survives, flagged truncated`, () => {
    const branches = Array.from(
      { length: 40 },
      (_, i) => `if (x === ${i}) { a${i}(); } else { b${i}(); }`,
    ).join('\n');
    const m = parseCode(`function f(x: number) {\n${branches}\n}`, 'x.ts')!;
    const g = flowGraph(m.units[0]!);
    expect(g.truncated).toBe(true);
    // 40 diamonds + start + end, no branch bodies.
    expect(g.nodes.filter((n) => n.shape === 'diamond')).toHaveLength(40);
    expect(g.nodes.filter((n) => n.shape === 'box')).toHaveLength(0);
    expect(g.nodes).toHaveLength(42);
  });
});

describe('flowHasBranches', () => {
  test('true only when there is something to chart', () => {
    expect(flowHasBranches(unitOf(textFiles, 'showAllFilesState').flow)).toBe(true);
    expect(flowHasBranches(unitOf(textFiles, 'isMarkdownPath').flow)).toBe(false);
    expect(flowHasBranches(unitOf(docFamily, 'allowedModesFor').flow)).toBe(true);
    expect(flowHasBranches(null)).toBe(false);
  });
});
