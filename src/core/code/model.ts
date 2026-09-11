/**
 * The language-neutral model of a code file — what every Review view is a
 * projection of (review_plan.md §4.3). Produced by `parse.ts` through the
 * per-language extractors (`ts.ts`, `rust.ts`), which are the ONLY files
 * that know Lezer node names; everything downstream (plain English, forms,
 * call graph, flow charts, change badges, voice vocabulary) reads this.
 */

export type CodeLanguage = 'ts' | 'rust';

export type UnitKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'const'
  | 'module'
  | 'import';

export interface Param {
  /** The bound name, or the collapsed pattern text for a destructuring param. */
  name: string;
  /** Raw type text (annotation without the leading `:`), or null when untyped. */
  type: string | null;
  /** `x?: T` in TypeScript. */
  optional: boolean;
  /** `x: T = …` — a default makes the param optional for the caller too. */
  hasDefault: boolean;
  /** `...rest` in TypeScript. */
  rest: boolean;
  /** Rust borrows: `&T` is `ref`, `&mut T` is `mut`; everything else `none`. */
  ref: 'none' | 'ref' | 'mut';
}

export interface TypeRef {
  /** Raw single-line type text. */
  text: string;
  /**
   * When the type is an inline object type (`{ show: boolean; explicit: boolean }`)
   * its members, so plain English can spell the result field by field.
   */
  fields: Field[] | null;
}

export interface Field {
  name: string;
  /** Raw type text; null for an enum member without a payload/value. */
  type: string | null;
  optional: boolean;
  /** Doc comment body (markdown), or null. */
  doc: string | null;
  /** 1-based line of the field's declaration. */
  line: number;
}

/**
 * A function body as a control-flow tree — the input of the flow-chart step.
 * Straight-line statements collapse into one `seq` node listing each
 * statement's first line; every text field is whitespace-collapsed and cut at
 * {@link FLOW_TEXT_MAX} characters.
 */
export type FlowNode =
  | { kind: 'seq'; lines: [number, number]; items: string[] }
  | { kind: 'if'; line: number; cond: string; then: FlowNode[]; else: FlowNode[] | null }
  | { kind: 'loop'; line: number; header: string; body: FlowNode[] }
  | { kind: 'switch'; line: number; subject: string; arms: FlowArm[] }
  | { kind: 'try'; line: number; body: FlowNode[]; handlers: FlowArm[] }
  | {
      kind: 'return' | 'throw' | 'break' | 'continue';
      line: number;
      text: string;
      conditional: boolean;
    }
  | { kind: 'fn'; line: number; name: string; body: FlowNode[] };

/** A `switch`/`match` arm or a `catch`/`finally` handler. */
export interface FlowArm {
  label: string;
  body: FlowNode[];
}

/** Longest condition / header / item text kept in a {@link FlowNode}. */
export const FLOW_TEXT_MAX = 40;

/**
 * One source line of a unit, with the x-ray depth at which it appears. The
 * signature, doc comment and closing brace are depth 0; a control-flow
 * keyword (`if`, `for`, `match`, `return`, `try`…) directly in the body is
 * depth 1; a plain statement or a comment inside a body sits one deeper than
 * the keywords beside it. `hiddenLines` is 0 on a real line; {@link xrayLines}
 * emits `⋯ N lines` marker lines with `hiddenLines = N`.
 */
export interface SkeletonLine {
  line: number;
  depth: number;
  text: string;
  hiddenLines: number;
}

export interface CodeUnit {
  /** Stable within a parse: `${kind}:${qualifiedName}` (+ `#n` on a clash). */
  id: string;
  kind: UnitKind;
  name: string;
  /** `Foo.bar` for a class method, `impl Foo::bar` for an impl method. */
  qualifiedName: string;
  /** `export` in TypeScript, any `pub` in Rust (a trait impl's methods count). */
  exported: boolean;
  async: boolean;
  /** 1-based inclusive; starts at the doc comment / attributes when present. */
  lines: [number, number];
  /** The declaration's own line — where the hold gesture anchors. */
  signatureLine: number;
  /** Raw signature, whitespace-collapsed onto one line, without the body. */
  signature: string;
  params: Param[];
  /** Return type; for a `const`/`static` the declared type. Null when absent. */
  returns: TypeRef | null;
  /** Doc comment body as markdown (`/** *\/`, `///` markers stripped), or null. */
  doc: string | null;
  /** Members of a struct / interface / enum / class / object type alias. */
  fields: Field[];
  /**
   * Callee text found in the body, in first-seen order, deduped: `foo`,
   * `this.x`, `self.x`, `Self::x`, `Foo.bar`, `foo::bar`, `new Foo`, `name!`
   * (a Rust macro). A method called on a computed receiver is `.name`.
   */
  calls: string[];
  /** The body as a control-flow tree (root is a `fn` node), or null. */
  flow: FlowNode | null;
  /** Methods of a class / impl / trait, items of a module. */
  children: CodeUnit[];
  /** Every line of the unit with its x-ray depth. */
  skeleton: SkeletonLine[];
}

export interface ImportEntry {
  /** Module specifier (`./tab-workspaces`, `zustand`, `std::path`, `crate::x`). */
  source: string;
  /** Bound names; `*` for a wildcard, `* as ns` for a namespace import. */
  names: string[];
  line: number;
  /** `import type` (TypeScript only). */
  typeOnly: boolean;
}

export interface ImportGroup {
  /** Relative / `crate::` / `super::` / `self::` sources are internal. */
  kind: 'internal' | 'package';
  entries: ImportEntry[];
}

export interface CodeModel {
  language: CodeLanguage;
  units: CodeUnit[];
  /** Always two groups, internal first (either may be empty). */
  imports: ImportGroup[];
  /** Every declared name (units, members, fields, params), deduped. */
  identifiers: string[];
  /** Lezer error nodes; shown as a soft warning. */
  parseErrors: number;
}

/**
 * The x-ray at depth `depth`: lines at that depth or shallower survive, and
 * every run of deeper lines collapses into one `⋯ N lines` marker whose `line`
 * is the run's first line. `opened` raises the depth for individual runs
 * (keyed by that first line) — tapping a marker opens one level along one
 * path without unfolding the rest.
 */
export function xrayLines(
  skeleton: readonly SkeletonLine[],
  depth: number,
  opened?: ReadonlyMap<number, number>,
): SkeletonLine[] {
  const out: SkeletonLine[] = [];
  let i = 0;
  while (i < skeleton.length) {
    const first = skeleton[i]!;
    if (first.depth <= depth) {
      out.push(first);
      i += 1;
      continue;
    }
    let j = i;
    while (j < skeleton.length && skeleton[j]!.depth > depth) {
      j += 1;
    }
    const run = skeleton.slice(i, j);
    const inner = opened?.get(first.line);
    if (inner !== undefined && inner > depth) {
      out.push(...xrayLines(run, inner, opened));
    } else {
      out.push({
        line: first.line,
        depth: depth + 1,
        text: `⋯ ${run.length} ${run.length === 1 ? 'line' : 'lines'}`,
        hiddenLines: run.length,
      });
    }
    i = j;
  }
  return out;
}

/** Deepest level in a skeleton — the depth at which nothing is folded. */
export function skeletonMaxDepth(skeleton: readonly SkeletonLine[]): number {
  let max = 0;
  for (const l of skeleton) {
    if (l.depth > max) {
      max = l.depth;
    }
  }
  return max;
}
