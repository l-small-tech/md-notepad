import { describe, expect, test } from 'vitest';
import type { CodeUnit, Param } from '../model';
import { parseCode } from '../parse';
import {
  describeParam,
  describeType,
  describeUnit,
  docParams,
  joinList,
  splitTop,
  splitWords,
} from '../plain-english';

const param = (name: string, type: string | null, extra: Partial<Param> = {}): Param => ({
  name,
  type,
  optional: false,
  hasDefault: false,
  rest: false,
  ref: 'none',
  ...extra,
});

describe('describeType — the type table, one row per rule', () => {
  const rows: [string, string, 'ts' | 'rust'][] = [
    ['string', 'text', 'ts'],
    ['&str', 'text', 'rust'],
    ['String', 'text', 'rust'],
    ["&'static str", 'text', 'rust'],
    ['number', 'a number', 'ts'],
    ['usize', 'a number', 'rust'],
    ['i32', 'a number', 'rust'],
    ['f64', 'a number', 'rust'],
    ['boolean', 'yes or no', 'ts'],
    ['bool', 'yes or no', 'rust'],
    ['string[]', 'a list of text', 'ts'],
    ['readonly number[]', 'a list of numbers', 'ts'],
    ['Vec<u8>', 'a list of numbers', 'rust'],
    ['&[String]', 'a list of text', 'rust'],
    ['[&str; 8]', 'a list of text', 'rust'],
    ['Record<string, number>', 'a lookup of numbers by text', 'ts'],
    ['HashMap<String, Vec<u8>>', 'a lookup of lists of numbers by text', 'rust'],
    ['string | null', 'text, or nothing', 'ts'],
    ['number | undefined', 'a number, or nothing', 'ts'],
    ['string | null | undefined', 'text, or nothing', 'ts'],
    ['Option<u64>', 'a number, or nothing', 'rust'],
    ['Promise<string>', '(eventually) text', 'ts'],
    ['Promise<void>', '(eventually) nothing', 'ts'],
    ['Result<usize, String>', 'a number, or an error', 'rust'],
    ['FsResult<()>', 'nothing, or an error', 'rust'],
    ['() => void', 'something to run', 'ts'],
    ['(x: number) => string', 'something to run', 'ts'],
    ['Fn()', 'something to run', 'rust'],
    ['impl Fn(u8) -> u8', 'something to run', 'rust'],
    ['void', 'nothing', 'ts'],
    ['()', 'nothing', 'rust'],
    ['undefined', 'nothing', 'ts'],
    ['unknown', 'anything', 'ts'],
    ["'a' | 'b'", "one of 'a', 'b'", 'ts'],
    ['string | number', 'text or a number', 'ts'],
    ['[string, number]', 'text and a number', 'ts'],
    ['(u8, String)', 'a number and text', 'rust'],
    ['{ show: boolean; explicit: boolean }', '*show* (yes or no) and *explicit* (yes or no)', 'ts'],
    [
      '{ a: Record<string, number>, b?: string }',
      '*a* (a lookup of numbers by text) and *b* (text)',
      'ts',
    ],
    ['DocFamily', '`DocFamily`', 'ts'],
    ['fs::Metadata', '`fs::Metadata`', 'rust'],
    ['Option<Vec<DocFamily>>', 'a list of `DocFamily`, or nothing', 'ts'],
  ];
  for (const [type, phrase, lang] of rows) {
    test(`${type} → ${phrase}`, () => {
      expect(describeType(type, lang)).toBe(phrase);
    });
  }

  test('a named struct is spelled out field by field when it can be resolved', () => {
    const resolve = (name: string) =>
      name === 'PathStat'
        ? [
            { name: 'exists', type: 'bool', optional: false, doc: null, line: 1 },
            { name: 'mtime_ms', type: 'Option<u64>', optional: false, doc: null, line: 2 },
          ]
        : null;
    expect(describeType('PathStat', 'rust', resolve)).toBe(
      '*exists* (yes or no) and *mtime_ms* (a number, or nothing)',
    );
    expect(describeType('FsResult<PathStat>', 'rust', resolve)).toBe(
      '*exists* (yes or no) and *mtime_ms* (a number, or nothing), or an error',
    );
    expect(describeType('Other', 'rust', resolve)).toBe('`Other`');
  });
});

describe('describeParam — name rules win over the type', () => {
  const rows: [string, string | null, string][] = [
    ['dir', 'string', 'a folder path'],
    ['folder', 'string', 'a folder path'],
    ['path', 'PathBuf', 'a folder path'],
    ['notesDir', 'string', 'a folder path'],
    ['filePath', 'string', 'a file path'],
    ['name', 'string', 'a file name'],
    ['fileName', 'string', 'a file name'],
    ['file', 'File', 'a file name'],
    ['id', 'string', 'an id'],
    ['tabId', 'string', 'an id'],
    ['text', 'string', 'text'],
    ['content', 'string', 'text'],
    ['source', 'string', 'text'],
    ['count', 'number', 'a number'],
    ['n', 'number', 'a number'],
    ['len', 'usize', 'a number'],
    ['length', 'number', 'a number'],
    ['index', 'number', 'a number'],
    ['i', 'number', 'a number'],
    ['enabled', 'boolean', 'yes or no'],
    ['flag', 'boolean', 'yes or no'],
    ['on', 'boolean', 'yes or no'],
    ['isOpen', 'boolean', 'yes or no'],
    ['hasChildren', 'unknown', 'yes or no'],
    ['shouldSave', 'boolean', 'yes or no'],
    ['cb', '() => void', 'something to run'],
    ['callback', 'Function', 'something to run'],
    ['fn', 'F', 'something to run'],
    ['handler', 'Handler', 'something to run'],
    ['onClick', '(e: Event) => void', 'something to run'],
    ['opts', 'Options', 'options'],
    ['options', 'Partial<Options>', 'options'],
    ['config', 'Config', 'options'],
    ['list', 'number[]', 'a list of numbers'],
    ['items', 'Item[]', 'a list of `Item`'],
    ['xs', 'Vec<String>', 'a list of text'],
    ['items', 'Bag', 'a list of things'],
    // A plural name matching a rule becomes "a list of <plural noun>".
    ['dirs', 'string[]', 'a list of folders'],
    ['shownDirs', 'readonly string[]', 'a list of folders'],
    ['paths', 'Vec<PathBuf>', 'a list of folders'],
    ['names', 'string[]', 'a list of file names'],
    ['ids', 'string[]', 'a list of ids'],
    ['files', 'File[]', 'a list of file names'],
    // No rule: the type speaks.
    ['family', 'DocFamily', '`DocFamily`'],
    ['rootKey', 'string', 'text'],
    ['meta', '&fs::Metadata', '`fs::Metadata`'],
    ['value', null, 'something'],
  ];
  for (const [name, type, phrase] of rows) {
    test(`${name}: ${type ?? '(untyped)'} → ${phrase}`, () => {
      expect(describeParam(param(name, type), null, type?.includes('&') ? 'rust' : 'ts')).toBe(
        phrase,
      );
    });
  }

  test('optional and defaulted params are "an optional …"', () => {
    expect(describeParam(param('dir', 'string', { optional: true }))).toBe(
      'an optional folder path',
    );
    expect(describeParam(param('hiddenDirs', 'readonly string[]', { hasDefault: true }))).toBe(
      'an optional list of folders',
    );
    expect(describeParam(param('id', 'string', { optional: true }))).toBe('an optional id');
  });

  test('rest params are "any number of …"', () => {
    expect(describeParam(param('rest', 'number[]', { rest: true }))).toBe('any number of numbers');
  });

  test('`&mut` says the value may change; `&` is dropped as noise', () => {
    expect(describeParam(param('items', '&mut Vec<u8>', { ref: 'mut' }), null, 'rust')).toBe(
      'a list of numbers (and may change it)',
    );
    expect(describeParam(param('path', '&Path', { ref: 'ref' }), null, 'rust')).toBe(
      'a folder path',
    );
  });

  test('a @param doc line overrides the guess verbatim', () => {
    expect(describeParam(param('dir', 'string'), 'the folder to ask about.')).toBe(
      'the folder to ask about',
    );
    expect(
      describeParam(param('dir', 'string', { optional: true }), 'the folder to ask about'),
    ).toBe('an optional the folder to ask about');
  });
});

describe('docParams', () => {
  test('reads @param lines in JSDoc and typed forms', () => {
    const doc =
      'Does things.\n@param dir the folder to ask about\n@param {string} name - its name\n@param [opt] optional one';
    expect([...docParams(doc)]).toEqual([
      ['dir', 'the folder to ask about'],
      ['name', 'its name'],
      ['opt', 'optional one'],
    ]);
    expect(docParams(null).size).toBe(0);
  });
});

describe('describeUnit — the template sentence', () => {
  const ts = (src: string) => parseCode(src, 'x.ts')!;
  const rust = (src: string) => parseCode(src, 'x.rs')!;
  const first = (src: string, lang: 'ts' | 'rust' = 'ts'): CodeUnit =>
    (lang === 'ts' ? ts(src) : rust(src)).units[0]!;

  test('the worked example from the plan, verbatim', () => {
    const u = first(`export function showAllFilesState(
  dir: string,
  shownDirs: readonly string[],
  hiddenDirs: readonly string[] = [],
): { show: boolean; explicit: boolean } {}`);
    expect(describeUnit(u)).toBe(
      'showAllFilesState takes a folder path, a list of folders, and an optional list of folders, and gives back *show* (yes or no) and *explicit* (yes or no).',
    );
  });

  test('one param, a boolean result', () => {
    expect(describeUnit(first('export function isMarkdownPath(name: string): boolean {}'))).toBe(
      'isMarkdownPath takes a file name, and gives back yes or no.',
    );
  });

  test('no params is "takes nothing"; two params join with "and"', () => {
    expect(describeUnit(first('function tick(): void {}'))).toBe(
      'tick takes nothing, and gives back nothing.',
    );
    expect(describeUnit(first('function f(a: number, b: string): string {}'))).toBe(
      'f takes a number and text, and gives back text.',
    );
  });

  test('async says "eventually" once, unwrapping the Promise', () => {
    expect(describeUnit(first('async function load(id: string): Promise<string> {}'))).toBe(
      'load takes an id, and eventually gives back text.',
    );
    expect(describeUnit(first('async function save(id: string): Promise<void> {}'))).toBe(
      'save takes an id, and eventually gives back nothing.',
    );
  });

  test('an unannotated TypeScript function says only what it takes', () => {
    expect(describeUnit(first('function f(a: number) { return a; }'))).toBe('f takes a number.');
  });

  test('a @param doc line replaces the guess', () => {
    const u = first(`/**
 * Look.
 * @param dir the folder to ask about
 */
function look(dir: string, id: string): boolean {}`);
    expect(describeUnit(u)).toBe(
      'look takes the folder to ask about and an id, and gives back yes or no.',
    );
  });

  test('Rust: self is dropped, borrows are noise, `&mut` is said, `?`-style results phrase', () => {
    const m = rust(`impl Foo {
    pub fn code(&self) -> &'static str { "x" }
    pub fn bump(&mut self, items: &mut Vec<u8>, path: &Path) -> Result<usize, String> { Ok(1) }
    fn go(&self) {}
}`);
    const [code, bump, go] = m.units[0]!.children;
    expect(describeUnit(code!, { lang: 'rust' })).toBe('code takes nothing, and gives back text.');
    expect(describeUnit(bump!, { lang: 'rust' })).toBe(
      'bump takes a list of numbers (and may change it) and a folder path, and gives back a number, or an error.',
    );
    expect(describeUnit(go!, { lang: 'rust' })).toBe('go takes nothing, and gives back nothing.');
  });

  test('Rust: a struct return type is spelled field by field through the resolver', () => {
    const m = rust(`pub struct PathStat { pub exists: bool, pub mtime_ms: Option<u64> }
pub fn stat_path(path: PathBuf) -> FsResult<PathStat> { todo!() }`);
    const resolve = (name: string) =>
      m.units.find((u) => u.name === name && u.fields.length > 0)?.fields ?? null;
    expect(describeUnit(m.units[1]!, { lang: 'rust', resolve })).toBe(
      'stat_path takes a folder path, and gives back *exists* (yes or no) and *mtime_ms* (a number, or nothing), or an error.',
    );
  });

  test('non-function kinds get a sentence of the same flavour', () => {
    const m = ts(`export interface Shape { id: string; label?: string }
export enum Color { Red, Green }
export const LIMIT: number = 3;
export type Family = 'a' | 'b';
export class Box { grow(): void {} shrink(): void {} }
export namespace Util { export const z = 1; }`);
    const [shape, color, limit, family, box, util] = m.units;
    expect(describeUnit(shape!)).toBe('Shape holds *id* (text) and *label* (text).');
    expect(describeUnit(color!)).toBe('Color is one of Red or Green.');
    expect(describeUnit(limit!)).toBe('LIMIT is a number.');
    expect(describeUnit(family!)).toBe("Family means one of 'a', 'b'.");
    expect(describeUnit(box!)).toBe('Box offers grow and shrink.');
    expect(describeUnit(util!)).toBe('Util offers z.');
    const r = rust(
      'pub struct FileText { pub text: String, pub mtime_ms: u64 }\nimpl FileText { fn a() {} }',
    );
    expect(describeUnit(r.units[0]!, { lang: 'rust' })).toBe(
      'FileText holds *text* (text) and *mtime_ms* (a number).',
    );
    expect(describeUnit(r.units[1]!, { lang: 'rust' })).toBe('FileText offers a.');
  });
});

describe('helpers', () => {
  test('joinList uses the Oxford comma from three items on', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(joinList(['a', 'b', 'c'], 'or')).toBe('a, b, or c');
  });

  test('splitWords handles camelCase, snake_case and acronyms', () => {
    expect(splitWords('shownDirs')).toEqual(['shown', 'dirs']);
    expect(splitWords('mtime_ms')).toEqual(['mtime', 'ms']);
    expect(splitWords('_privateId')).toEqual(['private', 'id']);
    expect(splitWords('HTMLElement')).toEqual(['html', 'element']);
  });

  test('splitTop respects brackets, quotes and arrows', () => {
    expect(splitTop('Record<string, number> | null', '|')).toEqual([
      'Record<string, number>',
      'null',
    ]);
    expect(splitTop("'a|b' | 'c'", '|')).toEqual(["'a|b'", "'c'"]);
    expect(splitTop('(a: number) => void | null', '|')).toEqual(['(a: number) => void', 'null']);
    expect(splitTop('a: T; b: U', ';')).toEqual(['a: T', 'b: U']);
  });
});
