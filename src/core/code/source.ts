/**
 * Helpers shared by the two extractors: line arithmetic over the source text,
 * text normalisation, doc-comment stripping and the skeleton depth painter.
 * Nothing here knows a Lezer node name — that knowledge stays in `ts.ts` and
 * `rust.ts`. The Lezer tree types are derived from `@lezer/lr` because
 * `@lezer/common` is only a transitive dependency.
 */

import type { LRParser } from '@lezer/lr';
import { FLOW_TEXT_MAX, type SkeletonLine } from './model';

export type Tree = ReturnType<LRParser['parse']>;
export type SyntaxNode = Tree['topNode'];

export class Source {
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 1-based line holding `offset` (an offset past the end is the last line). */
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo + 1;
  }

  /** The line a node ENDS on (`to` is exclusive, so the last covered offset). */
  endLineOf(node: { from: number; to: number }): number {
    return this.lineAt(Math.max(node.from, node.to - 1));
  }

  lineText(line: number): string {
    const from = this.lineStarts[line - 1];
    if (from === undefined) {
      return '';
    }
    const to = this.lineStarts[line] ?? this.text.length + 1;
    return this.text.slice(from, to - 1).replace(/\r$/, '');
  }

  slice(from: number, to: number): string {
    return this.text.slice(from, to);
  }

  nodeText(node: { from: number; to: number }): string {
    return this.text.slice(node.from, node.to);
  }

  /** True when only whitespace separates two offsets. */
  blankBetween(from: number, to: number): boolean {
    return from >= to || /^\s*$/.test(this.text.slice(from, to));
  }
}

/** Whitespace-collapsed, trimmed single line. */
export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Collapse and cut to `max` characters with an ellipsis. */
export function cut(s: string, max = FLOW_TEXT_MAX): string {
  const one = collapse(s);
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function dedupe(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** The body of a `/** … *\/` comment as markdown, or null when it is not one. */
export function docFromBlockComment(raw: string): string | null {
  if (!raw.startsWith('/**') || raw.startsWith('/**/')) {
    return null;
  }
  const inner = raw.slice(3, raw.endsWith('*/') ? -2 : undefined);
  const lines = inner.split('\n').map((l) => l.replace(/^\s*\*(?!\/) ?/, '').replace(/\s+$/, ''));
  return trimBlankLines(lines);
}

/** The body of a run of `///` (or `//!`) lines as markdown. */
export function docFromLineComments(raws: readonly string[]): string | null {
  const lines = raws.map((r) => r.replace(/^\s*\/\/[/!] ?/, '').replace(/\s+$/, ''));
  return trimBlankLines(lines);
}

function trimBlankLines(lines: string[]): string | null {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') {
    start += 1;
  }
  while (end > start && lines[end - 1]!.trim() === '') {
    end -= 1;
  }
  const body = lines.slice(start, end);
  if (body.length === 0) {
    return null;
  }
  // Drop a common indent left after the markers (continuation lines).
  const indent = Math.min(
    ...body.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)![0].length),
  );
  return body.map((l) => l.slice(Math.min(indent, l.length))).join('\n');
}

/**
 * Paints x-ray depths over a unit's line span. Extractors call `range`/`line`
 * top-down (parents first, children override), then `build` turns the paint
 * into {@link SkeletonLine}s.
 */
export class SkeletonPainter {
  private readonly depths: number[];

  constructor(
    private readonly src: Source,
    readonly first: number,
    readonly last: number,
  ) {
    this.depths = new Array<number>(Math.max(0, last - first + 1)).fill(0);
  }

  range(fromLine: number, toLine: number, depth: number): void {
    const a = Math.max(fromLine, this.first);
    const b = Math.min(toLine, this.last);
    for (let n = a; n <= b; n += 1) {
      this.depths[n - this.first] = depth;
    }
  }

  line(n: number, depth: number): void {
    this.range(n, n, depth);
  }

  build(): SkeletonLine[] {
    return this.depths.map((depth, i) => ({
      line: this.first + i,
      depth,
      text: this.src.lineText(this.first + i),
      hiddenLines: 0,
    }));
  }
}

/** Count Lezer error nodes in a tree. */
export function countErrors(tree: Tree): number {
  let n = 0;
  tree.iterate({
    enter(node) {
      if (node.type.isError) {
        n += 1;
      }
    },
  });
  return n;
}

/** Direct children of a node, in order. */
export function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    out.push(c);
  }
  return out;
}

/** The first direct child whose name is in `names`, or null. */
export function childNamed(node: SyntaxNode, ...names: string[]): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (names.includes(c.name)) {
      return c;
    }
  }
  return null;
}

/**
 * True when a node of one of `names` occurs anywhere under `root`, not
 * descending into subtrees named in `stopAt` (a closure's `?` is not the
 * enclosing function's early exit).
 */
export function containsNode(
  root: SyntaxNode,
  names: readonly string[],
  stopAt: readonly string[],
): boolean {
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (names.includes(c.name)) {
      return true;
    }
    if (!stopAt.includes(c.name) && containsNode(c, names, stopAt)) {
      return true;
    }
  }
  return false;
}

/** Ids assigned as `${kind}:${qualifiedName}`, with `#2`, `#3`… on a clash. */
export class IdAllocator {
  private readonly seen = new Map<string, number>();

  next(kind: string, qualifiedName: string): string {
    const base = `${kind}:${qualifiedName}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  }
}
