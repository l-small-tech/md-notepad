import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { xrayLines } from '../model';
import { codeLanguageFor, parseCode } from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const textFiles = parseCode(fixture('text-files.ts.txt'), 'src/core/text-files.ts')!;
const docFamily = parseCode(fixture('doc-family.ts.txt'), 'doc-family.ts')!;

const unit = (name: string) => {
  const u = textFiles.units.find((x) => x.name === name);
  if (!u) {
    throw new Error(`no unit ${name}`);
  }
  return u;
};

describe('codeLanguageFor / parseCode dispatch', () => {
  test('TypeScript and JavaScript extensions map to ts, .rs to rust, others to null', () => {
    for (const p of [
      'a.ts',
      'a.tsx',
      'a.js',
      'a.jsx',
      'a.mjs',
      'a.cjs',
      'C:\\x\\y.TS',
      '.ts',
      'ts',
    ]) {
      expect(codeLanguageFor(p), p).toBe('ts');
    }
    expect(codeLanguageFor('src-tauri/src/main.rs')).toBe('rust');
    expect(codeLanguageFor('notes.md')).toBeNull();
    expect(codeLanguageFor('Makefile')).toBeNull();
    expect(codeLanguageFor(null)).toBeNull();
    expect(parseCode('x', 'notes.md')).toBeNull();
    expect(parseCode('fn main() {}', '.rs')?.language).toBe('rust');
  });

  test('never throws on broken input; Lezer errors are counted', () => {
    const m = parseCode('export function (: {', 'x.ts')!;
    expect(m.language).toBe('ts');
    expect(m.parseErrors).toBeGreaterThan(0);
    expect(textFiles.parseErrors).toBe(0);
    expect(docFamily.parseErrors).toBe(0);
  });
});

describe('text-files.ts', () => {
  test('every top-level function is a unit, in source order, with its export flag', () => {
    expect(textFiles.units.map((u) => [u.kind, u.name, u.exported])).toEqual([
      ['function', 'isMarkdownPath', true],
      ['function', 'isEditableTextPath', true],
      ['function', 'dirKey', false],
      ['function', 'isAtOrBelow', false],
      ['function', 'showAllFilesState', true],
      ['function', 'showsAllFiles', true],
      ['function', 'toggleShowAllFiles', true],
    ]);
    expect(textFiles.units.map((u) => u.id)).toContain('function:showAllFilesState');
  });

  test('line spans start at the doc comment; signatureLine is the declaration', () => {
    const u = unit('showAllFilesState');
    expect(u.lines).toEqual([34, 65]);
    expect(u.signatureLine).toBe(43);
    expect(unit('isMarkdownPath').lines).toEqual([12, 16]);
    expect(unit('isMarkdownPath').signatureLine).toBe(13);
  });

  test('signature is the raw declaration on one line, without the body', () => {
    expect(unit('isMarkdownPath').signature).toBe(
      'export function isMarkdownPath(name: string): boolean',
    );
    expect(unit('showAllFilesState').signature).toBe(
      'export function showAllFilesState( dir: string, shownDirs: readonly string[], hiddenDirs: readonly string[] = [], ): { show: boolean; explicit: boolean }',
    );
  });

  test('params carry name, type, optional and default flags', () => {
    expect(unit('showAllFilesState').params).toEqual([
      { name: 'dir', type: 'string', optional: false, hasDefault: false, rest: false, ref: 'none' },
      {
        name: 'shownDirs',
        type: 'readonly string[]',
        optional: false,
        hasDefault: false,
        rest: false,
        ref: 'none',
      },
      {
        name: 'hiddenDirs',
        type: 'readonly string[]',
        optional: false,
        hasDefault: true,
        rest: false,
        ref: 'none',
      },
    ]);
  });

  test('an inline object return type is broken into fields', () => {
    const r = unit('showAllFilesState').returns!;
    expect(r.text).toBe('{ show: boolean; explicit: boolean }');
    expect(r.fields?.map((f) => [f.name, f.type, f.optional])).toEqual([
      ['show', 'boolean', false],
      ['explicit', 'boolean', false],
    ]);
    expect(unit('isMarkdownPath').returns).toEqual({ text: 'boolean', fields: null });
  });

  test('doc comments are stripped of their markers', () => {
    expect(unit('isMarkdownPath').doc).toBe('True for markdown files (`.md` / `.markdown`).');
    expect(unit('showAllFilesState').doc).toMatch(/^"Show unsupported files" for a folder\./);
    expect(unit('showAllFilesState').doc).toMatch(/plain source text\.$/);
    expect(unit('showAllFilesState').doc).not.toContain('*');
  });

  test('calls list callee text in first-seen order, deduped', () => {
    expect(unit('showAllFilesState').calls).toEqual(['dirKey', 'isAtOrBelow', 'consider']);
    expect(unit('isMarkdownPath').calls).toEqual(['name.toLowerCase', 'lower.endsWith']);
    // A method on a computed receiver is recorded as `.name`.
    expect(unit('isEditableTextPath').calls).toEqual([
      'isMarkdownPath',
      '.endsWith',
      'name.toLowerCase',
    ]);
  });

  test('imports are grouped internal vs package', () => {
    expect(textFiles.imports).toEqual([
      {
        kind: 'internal',
        entries: [{ source: './tab-workspaces', names: ['pathKey'], line: 10, typeOnly: false }],
      },
      { kind: 'package', entries: [] },
    ]);
    const internal = docFamily.imports[0]!.entries;
    expect(internal.map((e) => e.source)).toEqual([
      './images',
      './import/registry',
      './session/plan-flush',
      './text-files',
      './types',
    ]);
    expect(internal[4]).toEqual({
      source: './types',
      names: ['EditorMode', 'TabKind'],
      line: 21,
      typeOnly: true,
    });
  });

  test('identifiers include every declared name and param, deduped', () => {
    expect(textFiles.identifiers).toEqual([
      'isMarkdownPath',
      'name',
      'isEditableTextPath',
      'dirKey',
      'dir',
      'isAtOrBelow',
      'path',
      'rootKey',
      'showAllFilesState',
      'shownDirs',
      'hiddenDirs',
      'showsAllFiles',
      'toggleShowAllFiles',
    ]);
  });

  test('flow tree: straight-line seq, inner function, loop, if, return', () => {
    const flow = unit('showAllFilesState').flow!;
    expect(flow.kind).toBe('fn');
    if (flow.kind !== 'fn') {
      return;
    }
    expect(flow.name).toBe('showAllFilesState');
    expect(flow.body.map((n) => n.kind)).toEqual(['seq', 'fn', 'seq', 'return']);
    const [first, consider, second, ret] = flow.body;
    expect(first).toEqual({
      kind: 'seq',
      lines: [48, 53],
      items: ['key = dirKey(dir)', 'best: { len: number; show: boolean; exp…'],
    });
    expect(second).toEqual({
      kind: 'seq',
      lines: [62, 63],
      items: ['consider(shownDirs, true)', 'consider(hiddenDirs, false)'],
    });
    expect(ret).toMatchObject({ kind: 'return', line: 64, conditional: false });
    if (consider?.kind !== 'fn') {
      throw new Error('expected inner fn');
    }
    expect(consider.name).toBe('consider');
    const loop = consider.body[0];
    if (loop?.kind !== 'loop') {
      throw new Error('expected loop');
    }
    expect(loop.header).toBe('for (const d of dirs)');
    expect(loop.line).toBe(55);
    expect(loop.body.map((n) => n.kind)).toEqual(['seq', 'if']);
    const branch = loop.body[1];
    if (branch?.kind !== 'if') {
      throw new Error('expected if');
    }
    // Condition text is cut at 40 characters.
    expect(branch.cond).toBe('root.length > best.len && isAtOrBelow(k…');
    expect(branch.cond.length).toBe(40);
    expect(branch.then.map((n) => n.kind)).toEqual(['seq']);
    expect(branch.else).toBeNull();
  });

  test('skeleton: signature and doc at depth 0, body keywords at 1, plain statements deeper', () => {
    const u = unit('showAllFilesState');
    const byLine = new Map(u.skeleton.map((l) => [l.line, l.depth]));
    expect(u.skeleton[0]).toEqual({ line: 34, depth: 0, text: '/**', hiddenLines: 0 });
    expect(byLine.get(43)).toBe(0); // export function …(
    expect(byLine.get(47)).toBe(0); // ): { … } {
    expect(byLine.get(48)).toBe(2); // const key = …
    expect(byLine.get(54)).toBe(1); // const consider = (…) => {
    expect(byLine.get(55)).toBe(2); // for (…) {
    expect(byLine.get(57)).toBe(3); // if (…) {
    expect(byLine.get(64)).toBe(1); // return …
    expect(byLine.get(65)).toBe(0); // }
    expect(u.skeleton.every((l) => l.hiddenLines === 0)).toBe(true);
  });

  test('x-ray at depth 1 keeps the outline and folds the rest into ⋯ markers', () => {
    const u = unit('showAllFilesState');
    const lines = xrayLines(u.skeleton, 1).map((l) => l.text.trim());
    expect(lines.slice(9)).toEqual([
      'export function showAllFilesState(',
      'dir: string,',
      'shownDirs: readonly string[],',
      'hiddenDirs: readonly string[] = [],',
      '): { show: boolean; explicit: boolean } {',
      '⋯ 6 lines',
      'const consider = (dirs: readonly string[], show: boolean): void => {',
      '⋯ 6 lines',
      '};',
      '⋯ 2 lines',
      'return { show: best.show, explicit: best.explicit };',
      '}',
    ]);
    const marker = xrayLines(u.skeleton, 1).find((l) => l.hiddenLines > 0)!;
    expect(marker).toEqual({ line: 48, depth: 2, text: '⋯ 6 lines', hiddenLines: 6 });
  });
});

describe('doc-family.ts', () => {
  test('type aliases and consts are units; a switch becomes arms', () => {
    expect(docFamily.units.map((u) => [u.kind, u.name])).toEqual([
      ['type', 'DocFamily'],
      ['const', 'MARKDOWN_MODES'],
      ['const', 'SVG_MODES'],
      ['const', 'CODE_MODES'],
      ['const', 'TERMINAL_MODES'],
      ['function', 'docFamilyFor'],
      ['function', 'docFamilyForTab'],
      ['function', 'allowedModesFor'],
      ['function', 'isModeAllowed'],
      ['function', 'defaultModeFor'],
    ]);
    const alias = docFamily.units[0]!;
    expect(alias.returns?.text).toBe("'markdown' | 'svg' | 'code' | 'terminal'");
    expect(alias.exported).toBe(true);
    const modes = docFamily.units[3]!;
    expect(modes.lines).toEqual([27, 32]);
    expect(modes.returns?.text).toBe('readonly EditorMode[]');
    expect(modes.exported).toBe(false);

    const flow = docFamily.units.find((u) => u.name === 'allowedModesFor')!.flow!;
    if (flow.kind !== 'fn' || flow.body[0]?.kind !== 'switch') {
      throw new Error('expected switch');
    }
    const sw = flow.body[0];
    expect(sw.subject).toBe('family');
    expect(sw.arms.map((a) => a.label)).toEqual(["'svg'", "'code'", "'terminal'", 'default']);
    expect(sw.arms[0]!.body).toEqual([
      { kind: 'return', line: 72, text: 'SVG_MODES', conditional: false },
    ]);
  });
});

describe('classes, interfaces, enums and re-exports (inline)', () => {
  const src = `
import React, { useState } from 'react';
import * as ns from 'zustand';
export * from './x';

/** A shape. */
export interface Shape extends Base {
  /** the id */
  id: string;
  label?: string;
  readonly tags: string[];
  area(scale: number): number;
}

export enum Color { Red, Green = 2 }

export default class Box extends Base implements Shape {
  private count: number = 0;
  static shared?: Box;
  constructor(public readonly id: string) { super(); }
  /** Grow it. */
  async grow(by: number): Promise<void> { this.count += by; await Box.tick(); }
  #secret(): void {}
  private hidden(): void {}
  get size(): number { return this.count; }
}

const helper = async (n: number): Promise<string> => String(n);
function later() {}
export { later as afterwards };
export namespace Util { export const z = 1; }
`;
  const m = parseCode(src, 'shapes.ts')!;
  const byName = (n: string) => m.units.find((u) => u.name === n)!;

  test('parses cleanly', () => {
    expect(m.parseErrors).toBe(0);
  });

  test('imports: default, namespace and re-export forms', () => {
    expect(m.imports[1]!.entries).toEqual([
      { source: 'react', names: ['React', 'useState'], line: 2, typeOnly: false },
      { source: 'zustand', names: ['* as ns'], line: 3, typeOnly: false },
    ]);
    expect(m.imports[0]!.entries).toEqual([
      { source: './x', names: ['*'], line: 4, typeOnly: false },
    ]);
  });

  test('interface fields with optional, readonly-stripped types, docs and method types', () => {
    const shape = byName('Shape');
    expect(shape.kind).toBe('interface');
    expect(shape.doc).toBe('A shape.');
    expect(shape.signature).toBe('export interface Shape extends Base');
    expect(shape.fields.map((f) => [f.name, f.type, f.optional, f.doc])).toEqual([
      ['id', 'string', false, 'the id'],
      ['label', 'string', true, null],
      ['tags', 'string[]', false, null],
      ['area', '(scale: number): number', false, null],
    ]);
  });

  test('enum members are fields with their value as type', () => {
    expect(byName('Color').fields.map((f) => [f.name, f.type])).toEqual([
      ['Red', null],
      ['Green', '2'],
    ]);
  });

  test('class: properties and constructor params are fields, methods are children', () => {
    const box = byName('Box');
    expect(box.kind).toBe('class');
    expect(box.exported).toBe(true);
    expect(box.fields.map((f) => [f.name, f.type, f.optional])).toEqual([
      ['count', 'number', false],
      ['shared', 'Box', true],
      ['id', 'string', false],
    ]);
    expect(box.children.map((c) => [c.kind, c.qualifiedName, c.exported, c.async])).toEqual([
      ['method', 'Box.constructor', true, false],
      ['method', 'Box.grow', true, true],
      ['method', 'Box.#secret', false, false],
      ['method', 'Box.hidden', false, false],
      ['method', 'Box.size', true, false],
    ]);
    const grow = box.children[1]!;
    expect(grow.doc).toBe('Grow it.');
    expect(grow.returns?.text).toBe('Promise<void>');
    expect(grow.calls).toEqual(['Box.tick']);
    expect(grow.id).toBe('method:Box.grow');
  });

  test('arrow-function consts are functions; export groups mark units exported', () => {
    const helper = byName('helper');
    expect(helper.kind).toBe('function');
    expect(helper.async).toBe(true);
    expect(helper.params.map((p) => p.name)).toEqual(['n']);
    expect(helper.returns?.text).toBe('Promise<string>');
    expect(helper.exported).toBe(false);
    expect(byName('later').exported).toBe(true);
  });

  test('a namespace is a module with children', () => {
    const util = byName('Util');
    expect(util.kind).toBe('module');
    expect(util.children.map((c) => [c.kind, c.qualifiedName, c.exported])).toEqual([
      ['const', 'Util.z', true],
    ]);
  });

  test('identifiers cover fields, members and params', () => {
    for (const n of [
      'Shape',
      'id',
      'label',
      'area',
      'Color',
      'Red',
      'Box',
      'grow',
      'by',
      'helper',
    ]) {
      expect(m.identifiers).toContain(n);
    }
    expect(new Set(m.identifiers).size).toBe(m.identifiers.length);
  });
});

describe('control flow (inline)', () => {
  const src = `
function f(a: number) {
  try {
    if (a > 1) { go(); } else if (a < 0) { back(); } else { stay(); }
  } catch (e) {
    throw e;
  } finally {
    done();
  }
  while (a--) { if (a === 3) break; else continue; }
  do { tick(); } while (a);
  return a;
}
`;
  const flow = parseCode(src, 'f.ts')!.units[0]!.flow!;
  if (flow.kind !== 'fn') {
    throw new Error('fn');
  }

  test('try/catch/finally, else-if chains, single-statement branches, do-while', () => {
    expect(flow.body.map((n) => n.kind)).toEqual(['try', 'loop', 'loop', 'return']);
    const tryNode = flow.body[0];
    if (tryNode?.kind !== 'try') {
      throw new Error('try');
    }
    expect(tryNode.handlers.map((h) => h.label)).toEqual(['catch (e)', 'finally']);
    expect(tryNode.handlers[0]!.body).toEqual([
      { kind: 'throw', line: 6, text: 'e', conditional: false },
    ]);
    const ifNode = tryNode.body[0];
    if (ifNode?.kind !== 'if') {
      throw new Error('if');
    }
    expect(ifNode.cond).toBe('a > 1');
    expect(ifNode.then).toEqual([{ kind: 'seq', lines: [4, 4], items: ['go()'] }]);
    const elseIf = ifNode.else?.[0];
    if (elseIf?.kind !== 'if') {
      throw new Error('else if');
    }
    expect(elseIf.cond).toBe('a < 0');
    expect(elseIf.else).toEqual([{ kind: 'seq', lines: [4, 4], items: ['stay()'] }]);

    const whileNode = flow.body[1];
    if (whileNode?.kind !== 'loop') {
      throw new Error('while');
    }
    expect(whileNode.header).toBe('while (a--)');
    const inner = whileNode.body[0];
    if (inner?.kind !== 'if') {
      throw new Error('inner if');
    }
    expect(inner.then[0]?.kind).toBe('break');
    expect(inner.else?.[0]?.kind).toBe('continue');

    const doNode = flow.body[2];
    if (doNode?.kind !== 'loop') {
      throw new Error('do');
    }
    expect(doNode.header).toBe('do … while (a)');
  });
});
