/**
 * Mermaid source for the two Review diagrams (review_plan.md §5.1, §5.2):
 * the in-file call graph and one unit's flow chart. Text only — the
 * existing `preview/mermaid.ts` renders it and the fullscreen viewer zooms it.
 *
 * Every label is quoted and escaped with mermaid's entity codes (`#quot;`,
 * `#lt;`, `#gt;`, `#35;`, `#124;`), so a condition like `a < b || c` renders
 * verbatim under `securityLevel: 'strict'`. Node ids are `[A-Za-z0-9_]` only
 * and never a mermaid keyword (`end`, `subgraph`…), whatever a unit is called.
 */

import { flattenUnits, resolveCalls } from './calls';
import type { FlowGraph } from './flow';
import type { CodeModel, CodeUnit, UnitKind } from './model';

/** Above this many nodes the call graph starts in focus mode. */
export const CALL_GRAPH_FOCUS_AT = 40;
/** The most nodes a call graph ever carries; the rest are counted, not drawn. */
export const CALL_GRAPH_MAX_NODES = 150;
/** Units at least this long show their line count under the name. */
const HEAVY_LINES = 20;

/** Escape text for a `["…"]` label: mermaid entity codes, `#` first. */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/\|/g, '#124;');
}

const RESERVED = new Set([
  'end',
  'subgraph',
  'graph',
  'flowchart',
  'style',
  'class',
  'classdef',
  'click',
  'default',
  'linkstyle',
  'direction',
]);

/** A mermaid-safe id from any text; `used` guarantees uniqueness. */
export function safeId(text: string, used: Set<string>): string {
  let base = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (base === '' || /^[0-9]/.test(base) || RESERVED.has(base.toLowerCase())) {
    base = `n_${base}`;
  }
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}_${n++}`;
  }
  used.add(id);
  return id;
}

/** Kind glyphs (review_plan.md §5). */
export function kindGlyph(kind: UnitKind): string {
  switch (kind) {
    case 'function':
    case 'method':
      return 'ƒ';
    case 'struct':
    case 'interface':
    case 'type':
      return '▦';
    case 'enum':
      return '◆';
    case 'class':
    case 'impl':
    case 'trait':
    case 'module':
      return '▣';
    case 'const':
      return '≡';
    case 'import':
      return '▤';
  }
}

export function lineCount(unit: CodeUnit): number {
  return unit.lines[1] - unit.lines[0] + 1;
}

export interface CallGraphOptions {
  /** Unit ids to ring in amber (the What-changed step fills this). */
  changed?: Set<string>;
  /**
   * `true` forces focus mode, `false` forces the full graph; omitted, focus
   * switches on by itself above {@link CALL_GRAPH_FOCUS_AT} nodes.
   */
  focus?: boolean;
}

export interface CallGraphText {
  text: string;
  /** Mermaid node id → unit id, for click handlers on the rendered SVG. */
  nodes: { id: string; unitId: string }[];
  /** Focus mode was applied (exported units + one-hop neighbours). */
  focused: boolean;
  /** Units that would be nodes but were left out (focus or the hard cap). */
  omitted: number;
  /** Nodes in the full, unfocused graph. */
  total: number;
}

const CALLABLE = new Set<UnitKind>(['function', 'method']);

/** The units a call graph draws: every function / method, plus anything with an edge. */
function callGraphUnits(model: CodeModel): CodeUnit[] {
  const { edges } = resolveCalls(model);
  const touched = new Set<string>();
  for (const e of edges) {
    touched.add(e.from);
    touched.add(e.to);
  }
  return flattenUnits(model).filter((u) => CALLABLE.has(u.kind) || touched.has(u.id));
}

/**
 * The call graph as `flowchart TD`. Caller → callee. Exported units get a
 * bold border, changed units the amber ring, both when both.
 */
export function callGraphMermaid(model: CodeModel, opts: CallGraphOptions = {}): CallGraphText {
  const { edges } = resolveCalls(model);
  const all = callGraphUnits(model);
  const total = all.length;
  const focused = opts.focus ?? total > CALL_GRAPH_FOCUS_AT;

  let units = all;
  if (focused) {
    const exported = new Set(all.filter((u) => u.exported).map((u) => u.id));
    const keep = new Set(exported);
    for (const e of edges) {
      // One hop from an EXPORTED unit only — never from a neighbour just kept.
      if (exported.has(e.from)) {
        keep.add(e.to);
      }
      if (exported.has(e.to)) {
        keep.add(e.from);
      }
    }
    units = all.filter((u) => keep.has(u.id));
  }
  if (units.length > CALL_GRAPH_MAX_NODES) {
    units = units.slice(0, CALL_GRAPH_MAX_NODES);
  }

  const used = new Set<string>();
  const idOf = new Map<string, string>();
  const nodes: { id: string; unitId: string }[] = [];
  const lines: string[] = ['flowchart TD'];
  for (const u of units) {
    const id = safeId(u.name, used);
    idOf.set(u.id, id);
    nodes.push({ id, unitId: u.id });
    const label = [`${kindGlyph(u.kind)} ${u.name}`];
    if (lineCount(u) >= HEAVY_LINES) {
      label.push(`${lineCount(u)} lines`);
    }
    lines.push(`  ${id}["${label.map(escapeLabel).join('<br/>')}"]`);
  }
  for (const e of edges) {
    const from = idOf.get(e.from);
    const to = idOf.get(e.to);
    if (from && to) {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  const exported: string[] = [];
  const changed: string[] = [];
  const both: string[] = [];
  for (const u of units) {
    const id = idOf.get(u.id)!;
    const isChanged = opts.changed?.has(u.id) ?? false;
    if (u.exported && isChanged) {
      both.push(id);
    } else if (u.exported) {
      exported.push(id);
    } else if (isChanged) {
      changed.push(id);
    }
  }
  lines.push('  classDef exported stroke-width:2px,font-weight:bold');
  lines.push('  classDef changed stroke:#d97706,stroke-width:3px');
  lines.push('  classDef exportedChanged stroke:#d97706,stroke-width:3px,font-weight:bold');
  if (exported.length > 0) {
    lines.push(`  class ${exported.join(',')} exported`);
  }
  if (changed.length > 0) {
    lines.push(`  class ${changed.join(',')} changed`);
  }
  if (both.length > 0) {
    lines.push(`  class ${both.join(',')} exportedChanged`);
  }
  return { text: lines.join('\n'), nodes, focused, omitted: total - units.length, total };
}

function shapeText(shape: FlowGraph['nodes'][number]['shape'], label: string): string {
  switch (shape) {
    case 'diamond':
      return `{"${label}"}`;
    case 'terminal':
    case 'loop':
      return `(["${label}"])`;
    default:
      return `["${label}"]`;
  }
}

/** One unit's flow graph as `flowchart TD`; inner functions are subgraphs. */
export function flowMermaid(graph: FlowGraph): string {
  const lines: string[] = ['flowchart TD'];
  const declare = (n: FlowGraph['nodes'][number], indent: string): void => {
    lines.push(`${indent}${n.id}${shapeText(n.shape, n.lines.map(escapeLabel).join('<br/>'))}`);
  };
  for (const n of graph.nodes) {
    if (n.subgraph === null) {
      declare(n, '  ');
    }
  }
  for (const sg of graph.subgraphs) {
    lines.push(`  subgraph ${sg.id}["${escapeLabel(sg.label)}"]`);
    for (const n of graph.nodes) {
      if (n.subgraph === sg.id) {
        declare(n, '    ');
      }
    }
    lines.push('  end');
  }
  for (const e of graph.edges) {
    lines.push(
      e.label === null
        ? `  ${e.from} --> ${e.to}`
        : `  ${e.from} -->|"${escapeLabel(e.label)}"| ${e.to}`,
    );
  }
  return lines.join('\n');
}
