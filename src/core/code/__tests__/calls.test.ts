import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { flattenUnits, implTargetName, resolveCalls } from '../calls';
import { parseCode } from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const textFiles = parseCode(fixture('text-files.ts.txt'), 'src/core/text-files.ts')!;
const fs = parseCode(fixture('fs.rs.txt'), 'fs.rs')!;

describe('resolveCalls', () => {
  test('text-files.ts: plain calls resolve caller → callee; unknown callees are dropped', () => {
    const edges = resolveCalls(textFiles).edges.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual([
      'function:isEditableTextPath -> function:isMarkdownPath',
      'function:isAtOrBelow -> function:dirKey',
      'function:showAllFilesState -> function:dirKey',
      'function:showAllFilesState -> function:isAtOrBelow',
      'function:showsAllFiles -> function:showAllFilesState',
      'function:toggleShowAllFiles -> function:dirKey',
      'function:toggleShowAllFiles -> function:showsAllFiles',
      'function:toggleShowAllFiles -> function:isAtOrBelow',
    ]);
    // `name.toLowerCase`, `.endsWith`, the inner `consider` — none is a unit.
    expect(edges.some((e) => e.includes('toLowerCase') || e.includes('consider'))).toBe(false);
  });

  test('fs.rs: self.x inside an impl resolves to the method of that type; free calls resolve', () => {
    const edges = resolveCalls(fs).edges.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toContain(
      'method:impl Serialize for FsError::serialize -> method:impl FsError::code',
    );
    expect(edges).toContain('function:is_listed_file -> function:is_text_path');
    expect(edges).toContain('function:read_text_file -> function:not_found_or_io');
    // Enum variants (`FsError::NotFound`), macros (`format!`) and library
    // calls (`fs::read`, `Ok`) never become edges.
    expect(edges.some((e) => /NotFound|format|fs::read|-> .*:Ok$/.test(e))).toBe(false);
  });

  test('this.x, Self::x, Foo.bar, Foo::bar and new Foo resolve within classes and impls', () => {
    const ts = parseCode(
      `
export class Box {
  grow() { this.tick(); Box.tick(); }
  tick() { helper(); }
  static make() { return new Box(); }
}
function helper() { new Box(); }
`,
      'x.ts',
    )!;
    expect(resolveCalls(ts).edges).toEqual([
      { from: 'method:Box.grow', to: 'method:Box.tick' },
      { from: 'method:Box.tick', to: 'function:helper' },
      { from: 'method:Box.make', to: 'class:Box' },
      { from: 'function:helper', to: 'class:Box' },
    ]);

    const rs = parseCode(
      `
struct Foo;
impl Foo {
  fn a(&self) { self.b(); Self::c(); Foo::c(); }
  fn b(&self) {}
  fn c() { free(); }
}
impl Default for Foo {
  fn default() -> Self { Foo::c(); Self::c(); Foo }
}
fn free() {}
`,
      'x.rs',
    )!;
    const edges = resolveCalls(rs).edges.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual([
      'method:impl Foo::a -> method:impl Foo::b',
      'method:impl Foo::a -> method:impl Foo::c',
      'method:impl Foo::c -> function:free',
      'method:impl Default for Foo::default -> method:impl Foo::c',
    ]);
  });

  test('edges are deduped and recursion keeps its self-edge', () => {
    const m = parseCode('function f(n: number) { f(n); f(n - 1); return g(); }\nfunction g() {}', 'x.ts')!;
    expect(resolveCalls(m).edges).toEqual([
      { from: 'function:f', to: 'function:f' },
      { from: 'function:f', to: 'function:g' },
    ]);
  });
});

describe('helpers', () => {
  test('implTargetName strips the trait and generics', () => {
    const rs = parseCode('struct A<T>(T);\nimpl<T> A<T> {}\nimpl<T> Clone for A<T> {}', 'x.rs')!;
    const impls = rs.units.filter((u) => u.kind === 'impl');
    expect(impls.map(implTargetName)).toEqual(['A', 'A']);
  });

  test('flattenUnits walks containers depth-first in source order', () => {
    expect(flattenUnits(fs).map((u) => u.name).slice(0, 5)).toEqual([
      'FsError',
      'FsError',
      'code',
      'Serialize for FsError',
      'serialize',
    ]);
  });
});
