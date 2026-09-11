import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { xrayLines } from '../model';
import { parseCode } from '../parse';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const fs = parseCode(fixture('fs.rs.txt'), 'src-tauri/src/commands/fs.rs')!;
const unit = (name: string) => {
  const u = fs.units.find((x) => x.name === name);
  if (!u) {
    throw new Error(`no unit ${name}`);
  }
  return u;
};

describe('fs.rs (slice)', () => {
  test('parses cleanly and lists every item in source order', () => {
    expect(fs.language).toBe('rust');
    expect(fs.parseErrors).toBe(0);
    expect(fs.units.map((u) => [u.kind, u.name, u.exported])).toEqual([
      ['enum', 'FsError', true],
      ['impl', 'FsError', false],
      ['impl', 'Serialize for FsError', true],
      ['type', 'FsResult', true],
      ['struct', 'FileText', true],
      ['struct', 'NoteMeta', true],
      ['struct', 'PathStat', true],
      ['struct', 'DirEntryMeta', true],
      ['const', 'IMAGE_EXTENSIONS', false],
      ['const', 'IMPORT_EXTENSIONS', false],
      ['const', 'TEXT_EXTENSIONS', false],
      ['function', 'has_extension', false],
      ['function', 'is_image_path', false],
      ['function', 'is_importable_path', false],
      ['function', 'is_text_path', true],
      ['function', 'is_listed_file', false],
      ['function', 'mtime_ms', false],
      ['function', 'not_found_or_io', false],
      ['function', 'read_text_file', true],
    ]);
  });

  test('`use` lines are package imports with their bound names', () => {
    expect(fs.imports[0]).toEqual({ kind: 'internal', entries: [] });
    expect(fs.imports[1]!.entries).toEqual([
      { source: 'serde', names: ['Serialize'], line: 14, typeOnly: false },
      { source: 'std', names: ['fs'], line: 15, typeOnly: false },
      { source: 'std::io', names: ['Write'], line: 16, typeOnly: false },
      { source: 'std::path', names: ['Path', 'PathBuf'], line: 17, typeOnly: false },
      { source: 'std::time', names: ['UNIX_EPOCH'], line: 18, typeOnly: false },
    ]);
  });

  test('an enum: doc + attributes start the span; variants are fields with payloads', () => {
    const e = unit('FsError');
    expect(e.lines).toEqual([20, 34]);
    expect(e.signatureLine).toBe(23);
    expect(e.signature).toBe('pub enum FsError');
    expect(e.doc).toBe(
      'Error contract. `code` is a closed union the frontend switches on;\n`message` is for logging/status-bar display only, never for logic.',
    );
    expect(e.fields.map((f) => [f.name, f.type])).toEqual([
      ['NotFound', '(PathBuf)'],
      ['Exists', '(PathBuf)'],
      ['InvalidPath', '(String)'],
      ['InvalidData', '(String)'],
      ['Io', '(#[from] std::io::Error)'],
    ]);
  });

  test('impl blocks: methods are children with `impl Foo::bar` names', () => {
    const inherent = fs.units[1]!;
    expect(inherent.qualifiedName).toBe('impl FsError');
    expect(inherent.lines).toEqual([36, 46]);
    expect(inherent.children.map((c) => [c.kind, c.qualifiedName, c.exported])).toEqual([
      ['method', 'impl FsError::code', true],
    ]);
    const code = inherent.children[0]!;
    expect(code.id).toBe('method:impl FsError::code');
    expect(code.signature).toBe("pub fn code(&self) -> &'static str");
    expect(code.params).toEqual([
      { name: 'self', type: '&Self', optional: false, hasDefault: false, rest: false, ref: 'ref' },
    ]);
    expect(code.returns).toEqual({ text: "&'static str", fields: null });

    const traitImpl = fs.units[2]!;
    expect(traitImpl.qualifiedName).toBe('impl Serialize for FsError');
    // A trait impl's methods are public through the trait.
    const serialize = traitImpl.children[0]!;
    expect(serialize.qualifiedName).toBe('impl Serialize for FsError::serialize');
    expect(serialize.exported).toBe(true);
    expect(serialize.params.map((p) => [p.name, p.type, p.ref])).toEqual([
      ['self', '&Self', 'ref'],
      ['serializer', 'S', 'none'],
    ]);
    expect(serialize.calls).toEqual([
      'serializer.serialize_struct',
      's.serialize_field',
      'self.code',
      'self.to_string',
      's.end',
    ]);
  });

  test('structs: fields with types; consts: the declared type as returns', () => {
    expect(unit('PathStat').fields.map((f) => [f.name, f.type])).toEqual([
      ['exists', 'bool'],
      ['mtime_ms', 'Option<u64>'],
    ]);
    expect(unit('PathStat').lines).toEqual([75, 80]);
    expect(unit('PathStat').signatureLine).toBe(77);
    expect(unit('IMAGE_EXTENSIONS').returns?.text).toBe('[&str; 8]');
    expect(unit('FsResult').returns?.text).toBe('Result<T, FsError>');
    expect(unit('FsResult').signature).toBe('pub type FsResult<T> = Result<T, FsError>');
  });

  test('functions: borrows, pub(crate), async, attributes, scoped calls and macros', () => {
    expect(unit('has_extension').params.map((p) => [p.name, p.type, p.ref])).toEqual([
      ['path', '&Path', 'ref'],
      ['wanted', '&str', 'ref'],
    ]);
    expect(unit('is_text_path').signature).toBe('pub(crate) fn is_text_path(path: &Path) -> bool');
    const read = unit('read_text_file');
    expect(read.async).toBe(true);
    expect(read.lines).toEqual([144, 167]);
    expect(read.signatureLine).toBe(151);
    expect(read.signature).toBe('pub async fn read_text_file(path: PathBuf) -> FsResult<FileText>');
    expect(read.calls).toEqual([
      '.map_err',
      'fs::metadata',
      'not_found_or_io',
      'fs::read',
      'String::from_utf8',
      'text.contains',
      'Err',
      'FsError::InvalidData',
      'format!',
      'Ok',
      'mtime_ms',
    ]);
    expect(unit('not_found_or_io').calls).toEqual([
      'e.kind',
      'FsError::NotFound',
      'path.to_path_buf',
      'FsError::Io',
    ]);
  });

  test('flow: `?` is a conditional early exit; `let x = match` is a switch with arms', () => {
    const flow = unit('read_text_file').flow!;
    if (flow.kind !== 'fn') {
      throw new Error('fn');
    }
    expect(flow.body.map((n) => n.kind)).toEqual(['seq', 'throw', 'seq', 'throw', 'switch', 'seq']);
    expect(flow.body[1]).toMatchObject({ kind: 'throw', line: 152, conditional: true });
    const sw = flow.body[4];
    if (sw?.kind !== 'switch') {
      throw new Error('switch');
    }
    expect(sw.subject).toBe('String::from_utf8(bytes)');
    expect(sw.arms.map((a) => a.label)).toEqual(["Ok(text) if !text.contains('\\0')", '_']);
    expect(sw.arms[1]!.body[0]).toMatchObject({ kind: 'return', line: 157, conditional: false });
  });

  test('flow: if / else with tail expressions', () => {
    const flow = unit('not_found_or_io').flow!;
    if (flow.kind !== 'fn' || flow.body[0]?.kind !== 'if') {
      throw new Error('if');
    }
    const branch = flow.body[0];
    expect(branch.cond).toBe('e.kind() == std::io::ErrorKind::NotFound');
    expect(branch.then).toEqual([
      { kind: 'seq', lines: [138, 138], items: ['FsError::NotFound(path.to_path_buf())'] },
    ]);
    expect(branch.else).toEqual([{ kind: 'seq', lines: [140, 140], items: ['FsError::Io(e)'] }]);
  });

  test('skeleton: docs, attributes and signature at 0; match at 1; arms at 2', () => {
    const u = unit('read_text_file');
    const byLine = new Map(u.skeleton.map((l) => [l.line, l.depth]));
    expect(byLine.get(144)).toBe(0); // /// Read a UTF-8 …
    expect(byLine.get(150)).toBe(0); // #[tauri::command]
    expect(byLine.get(151)).toBe(0); // pub async fn …
    expect(byLine.get(152)).toBe(2); // let meta = …?;
    expect(byLine.get(154)).toBe(1); // let text = match …
    expect(byLine.get(155)).toBe(2); // Ok(text) … => text,
    expect(byLine.get(156)).toBe(2); // _ => {
    expect(byLine.get(157)).toBe(3); // return Err(…
    expect(byLine.get(162)).toBe(1); // };
    expect(byLine.get(163)).toBe(2); // Ok(FileText {
    expect(byLine.get(167)).toBe(0); // }
    expect(xrayLines(u.skeleton, 1).map((l) => l.text.trim())).toEqual([
      '/// Read a UTF-8 text file plus its mtime in one IPC round trip.',
      '/// The mtime is the baseline for external-change conflict detection (M3).',
      "/// A file that isn't text — invalid UTF-8, or a NUL byte (which valid UTF-8",
      '/// binaries still carry) — is `INVALID_DATA`, so the frontend can say "not a',
      '/// text file" instead of opening a tab of garbage. The explorer lists every',
      '/// file in folders where unsupported files are shown; this is the gate.',
      '#[tauri::command]',
      'pub async fn read_text_file(path: PathBuf) -> FsResult<FileText> {',
      '⋯ 2 lines',
      'let text = match String::from_utf8(bytes) {',
      '⋯ 7 lines',
      '};',
      '⋯ 4 lines',
      '}',
    ]);
  });

  test('skeleton of a container: members at depth 1, their bodies deeper', () => {
    const impl = fs.units[1]!;
    const byLine = new Map(impl.skeleton.map((l) => [l.line, l.depth]));
    expect(byLine.get(36)).toBe(0); // impl FsError {
    expect(byLine.get(37)).toBe(1); // pub fn code(&self) …
    expect(byLine.get(38)).toBe(2); // match self {
    expect(byLine.get(39)).toBe(3); // FsError::NotFound(_) => …
    expect(byLine.get(46)).toBe(0); // }
    const e = unit('FsError');
    expect(e.skeleton.map((l) => l.depth)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
  });

  test('identifiers include items, variants, fields, methods and params', () => {
    for (const n of [
      'FsError',
      'NotFound',
      'code',
      'serialize',
      'serializer',
      'PathStat',
      'exists',
      'mtime_ms',
      'read_text_file',
      'path',
    ]) {
      expect(fs.identifiers).toContain(n);
    }
    expect(fs.identifiers).not.toContain('self');
    expect(new Set(fs.identifiers).size).toBe(fs.identifiers.length);
  });
});

describe('inline Rust: loops, traits, modules, internal use', () => {
  const src = `
use crate::commands::fs::{FsError, FsResult};
use super::util::{self, helper as h};
use std::collections::HashMap;

pub trait Thing {
    /// Go.
    fn go(&self, n: usize) -> bool;
    fn stop(&mut self) {}
}

pub mod inner {
    pub fn f() {}
    struct Hidden(u8, String);
}

fn walk(items: &mut Vec<u8>, limit: Option<usize>) -> Result<usize, String> {
    let mut total = 0;
    for i in items.iter() {
        if *i > 3 {
            continue;
        }
        total += 1;
    }
    while total > 0 {
        loop {
            break;
        }
        total -= 1;
    }
    let value = parse(items)?;
    let add = |d: u8| { d + 1 };
    println!("{}", value);
    Ok(total)
}
`;
  const m = parseCode(src, 'x.rs')!;
  const byName = (n: string) => m.units.find((u) => u.name === n)!;

  test('imports: crate/super are internal (self binds the module), std is a package', () => {
    expect(m.parseErrors).toBe(0);
    expect(m.imports[0]!.entries).toEqual([
      { source: 'crate::commands::fs', names: ['FsError', 'FsResult'], line: 2, typeOnly: false },
      { source: 'super::util', names: ['util', 'h'], line: 3, typeOnly: false },
    ]);
    expect(m.imports[1]!.entries).toEqual([
      { source: 'std::collections', names: ['HashMap'], line: 4, typeOnly: false },
    ]);
  });

  test('trait methods are children exported as the trait; `&mut self` is a mut ref', () => {
    const t = byName('Thing');
    expect(t.kind).toBe('trait');
    expect(t.children.map((c) => [c.qualifiedName, c.exported, c.doc])).toEqual([
      ['Thing::go', true, 'Go.'],
      ['Thing::stop', true, null],
    ]);
    expect(t.children[0]!.flow).toBeNull(); // no body
    expect(t.children[1]!.params[0]).toMatchObject({ name: 'self', ref: 'mut' });
  });

  test('modules nest items with `mod::name`; tuple structs number their fields', () => {
    const mod = byName('inner');
    expect(mod.kind).toBe('module');
    expect(mod.children.map((c) => [c.kind, c.qualifiedName, c.exported])).toEqual([
      ['function', 'inner::f', true],
      ['struct', 'inner::Hidden', false],
    ]);
    expect(mod.children[1]!.fields.map((f) => [f.name, f.type])).toEqual([
      ['0', 'u8'],
      ['1', 'String'],
    ]);
  });

  test('flow: for / while / loop with continue and break, `?` exit, closure, macro call', () => {
    const w = byName('walk');
    expect(w.params.map((p) => [p.name, p.type, p.ref])).toEqual([
      ['items', '&mut Vec<u8>', 'mut'],
      ['limit', 'Option<usize>', 'none'],
    ]);
    expect(w.calls).toEqual(['items.iter', 'parse', 'println!', 'Ok']);
    const flow = w.flow!;
    if (flow.kind !== 'fn') {
      throw new Error('fn');
    }
    expect(flow.body.map((n) => n.kind)).toEqual([
      'seq',
      'loop',
      'loop',
      'seq',
      'throw',
      'fn',
      'seq',
    ]);
    const forLoop = flow.body[1];
    if (forLoop?.kind !== 'loop') {
      throw new Error('for');
    }
    expect(forLoop.header).toBe('for i in items.iter()');
    expect(forLoop.body.map((n) => n.kind)).toEqual(['if', 'seq']);
    const cond = forLoop.body[0];
    if (cond?.kind !== 'if') {
      throw new Error('if');
    }
    expect(cond.cond).toBe('*i > 3');
    expect(cond.then).toEqual([{ kind: 'continue', line: 21, text: '', conditional: false }]);
    const whileLoop = flow.body[2];
    if (whileLoop?.kind !== 'loop') {
      throw new Error('while');
    }
    expect(whileLoop.header).toBe('while total > 0');
    expect(whileLoop.body[0]).toEqual({
      kind: 'loop',
      line: 26,
      header: 'loop',
      body: [{ kind: 'break', line: 27, text: '', conditional: false }],
    });
    expect(flow.body[4]).toEqual({
      kind: 'throw',
      line: 31,
      text: 'value = parse(items)?',
      conditional: true,
    });
    expect(flow.body[5]).toMatchObject({ kind: 'fn', name: 'add' });
    expect(flow.body[6]).toEqual({
      kind: 'seq',
      lines: [33, 34],
      items: ['println!("{}", value)', 'Ok(total)'],
    });
  });
});
