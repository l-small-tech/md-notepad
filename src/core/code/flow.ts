/**
 * Control flow as a graph (review_plan.md §5.2): one function's `FlowNode`
 * tree turned into the nodes and edges a flowchart draws. The collapse rules:
 *
 *  - straight-line statements (a `seq`) are ONE box listing their first
 *    identifiers (the extractor already collapsed them; here they become a
 *    single node);
 *  - an `if` is a diamond carrying the condition text; `yes` / `no` edges;
 *  - a loop is a stadium node; the body flows back into it (the back edge)
 *    and leaves it on a `done` edge; `break` leaves, `continue` goes back;
 *  - a `switch` / `match` is a diamond with one labelled edge per arm;
 *  - `return` / `throw` / `break` (outside a loop) end in a terminal node —
 *    a *conditional* exit (`?`, an `if x { return }` one-liner) also lets
 *    flow continue;
 *  - a `try` runs its body, each `catch` branches off the body's first node
 *    on its own labelled edge, and a `finally` collects every path;
 *  - an inner function becomes a subgraph the outer flow never enters;
 *  - above {@link FLOW_NODE_CAP} nodes the graph keeps depth 1 only (no
 *    branch or loop body is entered) and says so with `truncated`.
 */

import type { CodeUnit, FlowArm, FlowNode } from './model';

export type FlowShape = 'box' | 'diamond' | 'terminal' | 'loop';

export interface FlowGraphNode {
  id: string;
  shape: FlowShape;
  /** Label lines; the renderer joins them with a line break. */
  lines: string[];
  /** Subgraph id when the node belongs to an inner function. */
  subgraph: string | null;
}

export interface FlowGraphEdge {
  from: string;
  to: string;
  label: string | null;
}

export interface FlowSubgraph {
  id: string;
  label: string;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  subgraphs: FlowSubgraph[];
  /** The tree had more than {@link FLOW_NODE_CAP} nodes; only depth 1 is shown. */
  truncated: boolean;
}

/** Graphs bigger than this fall back to depth 1 (branch bodies unopened). */
export const FLOW_NODE_CAP = 60;

/** True when the tree has any branch or loop — i.e. a chart is worth drawing. */
export function flowHasBranches(flow: FlowNode | null): boolean {
  if (!flow) {
    return false;
  }
  switch (flow.kind) {
    case 'if':
    case 'loop':
    case 'switch':
    case 'try':
      return true;
    case 'fn':
      return flow.body.some(flowHasBranches);
    default:
      return false;
  }
}

/** A dangling edge waiting for the next node to connect to. */
interface Pending {
  from: string;
  label: string | null;
}

type Context = { kind: 'loop'; head: string; exits: Pending[] } | { kind: 'switch' };

class Builder {
  nodes: FlowGraphNode[] = [];
  edges: FlowGraphEdge[] = [];
  subgraphs: FlowSubgraph[] = [];
  private subgraph: string | null = null;
  private readonly stack: Context[] = [];
  private seq = 0;

  constructor(private readonly maxDepth: number) {}

  node(shape: FlowShape, lines: string[]): string {
    const id = `n${this.seq++}`;
    this.nodes.push({ id, shape, lines, subgraph: this.subgraph });
    return id;
  }

  connect(pending: readonly Pending[], to: string): void {
    for (const p of pending) {
      this.edges.push({ from: p.from, to, label: p.label });
    }
  }

  /** Walk `items`, entered by `pending`; returns the paths that leave it. */
  walk(items: readonly FlowNode[], pending: Pending[], depth: number): Pending[] {
    let open = pending;
    for (const item of items) {
      open = this.step(item, open, depth);
    }
    return open;
  }

  private step(item: FlowNode, pending: Pending[], depth: number): Pending[] {
    const enterBodies = depth < this.maxDepth;
    switch (item.kind) {
      case 'seq': {
        const id = this.node('box', item.items.length > 0 ? item.items : ['…']);
        this.connect(pending, id);
        return [{ from: id, label: null }];
      }
      case 'if': {
        const id = this.node('diamond', [`${item.cond}?`]);
        this.connect(pending, id);
        if (!enterBodies) {
          return [
            { from: id, label: 'yes' },
            { from: id, label: 'no' },
          ];
        }
        const yes = this.walk(item.then, [{ from: id, label: 'yes' }], depth + 1);
        const no = item.else
          ? this.walk(item.else, [{ from: id, label: 'no' }], depth + 1)
          : [{ from: id, label: 'no' }];
        return [...yes, ...no];
      }
      case 'loop': {
        const id = this.node('loop', [item.header]);
        this.connect(pending, id);
        if (!enterBodies) {
          return [{ from: id, label: 'done' }];
        }
        const ctx: Context = { kind: 'loop', head: id, exits: [] };
        this.stack.push(ctx);
        const ends = this.walk(item.body, [{ from: id, label: null }], depth + 1);
        this.stack.pop();
        this.connect(ends, id); // the back edge
        return [{ from: id, label: 'done' }, ...ctx.exits];
      }
      case 'switch': {
        const id = this.node('diamond', [item.subject]);
        this.connect(pending, id);
        const arms = item.arms.length > 0 ? item.arms : [{ label: 'default', body: [] }];
        if (!enterBodies) {
          return arms.map((arm) => ({ from: id, label: arm.label }));
        }
        this.stack.push({ kind: 'switch' });
        const out: Pending[] = [];
        for (const arm of arms) {
          out.push(...this.walk(arm.body, [{ from: id, label: arm.label }], depth + 1));
        }
        this.stack.pop();
        if (!arms.some(isDefaultArm)) {
          out.push({ from: id, label: 'else' });
        }
        return out;
      }
      case 'try': {
        if (!enterBodies) {
          const id = this.node('box', ['try…']);
          this.connect(pending, id);
          return [{ from: id, label: null }];
        }
        const before = this.nodes.length;
        let ends = this.walk(item.body, pending, depth + 1);
        const entry = this.nodes[before]?.id ?? null;
        const finallyArms: FlowArm[] = [];
        for (const handler of item.handlers) {
          if (/^finally\b/.test(handler.label)) {
            finallyArms.push(handler);
            continue;
          }
          const from = entry ?? this.node('box', ['try']);
          ends = ends.concat(this.walk(handler.body, [{ from, label: handler.label }], depth + 1));
        }
        for (const fin of finallyArms) {
          ends = this.walk(fin.body, ends, depth + 1);
        }
        return ends;
      }
      case 'return':
      case 'throw':
      case 'break':
      case 'continue':
        return this.exit(item, pending);
      case 'fn': {
        if (!enterBodies) {
          return pending;
        }
        const id = `sg${this.subgraphs.length}`;
        this.subgraphs.push({ id, label: `${item.name} (inner)` });
        const outer = this.subgraph;
        const outerStack = this.stack.splice(0);
        this.subgraph = id;
        const ends = this.walk(item.body, [], depth + 1);
        if (ends.length > 0 && this.nodes.some((n) => n.subgraph === id)) {
          this.connect(ends, this.node('terminal', ['end']));
        }
        this.subgraph = outer;
        this.stack.push(...outerStack);
        return pending;
      }
    }
  }

  private exit(
    item: Extract<FlowNode, { kind: 'return' | 'throw' | 'break' | 'continue' }>,
    pending: Pending[],
  ): Pending[] {
    const loop = [...this.stack].reverse().find((c) => c.kind === 'loop');
    if (item.kind === 'continue' && loop?.kind === 'loop') {
      this.connect(pending, loop.head);
      return [];
    }
    if (item.kind === 'break') {
      const top = this.stack[this.stack.length - 1];
      if (top?.kind === 'switch') {
        return pending; // ends the arm: flow leaves the switch
      }
      if (loop?.kind === 'loop') {
        loop.exits.push(...pending);
        return [];
      }
    }
    // A conditional throw is Rust's `?` (or `let … else`): the statement itself
    // is the box before it, so the terminal only says what happens on error.
    const label =
      item.conditional && item.kind === 'throw'
        ? 'on error: return it'
        : item.text
          ? `${item.kind} ${item.text}`
          : item.kind;
    const id = this.node('terminal', [label]);
    this.connect(pending, id);
    if (!item.conditional) {
      return [];
    }
    return [{ from: id, label: item.kind === 'throw' ? 'ok' : 'else' }];
  }
}

function isDefaultArm(arm: FlowArm): boolean {
  return arm.label === 'default' || arm.label === '_' || /^default\b/.test(arm.label);
}

function build(flow: Extract<FlowNode, { kind: 'fn' }>, maxDepth: number): Builder {
  const b = new Builder(maxDepth);
  const start = b.node('terminal', ['start']);
  const ends = b.walk(flow.body, [{ from: start, label: null }], 1);
  if (ends.length > 0) {
    b.connect(ends, b.node('terminal', ['end']));
  }
  return b;
}

/**
 * The flow graph of a unit. A unit without a flow tree (a type, a struct)
 * gives an empty graph.
 */
export function flowGraph(unit: CodeUnit): FlowGraph {
  const flow = unit.flow;
  if (!flow || flow.kind !== 'fn') {
    return { nodes: [], edges: [], subgraphs: [], truncated: false };
  }
  let b = build(flow, Number.POSITIVE_INFINITY);
  let truncated = false;
  if (b.nodes.length > FLOW_NODE_CAP) {
    b = build(flow, 1);
    truncated = true;
  }
  return { nodes: b.nodes, edges: b.edges, subgraphs: b.subgraphs, truncated };
}
