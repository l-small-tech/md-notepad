/**
 * Rust extractor: Lezer tree → {@link CodeModel}. With `ts.ts` this is the
 * only file that knows `@lezer/rust` node names. Same three walks per unit as
 * the TypeScript extractor: form data (params / fields), `flowOf*` (control
 * flow) and `paint*` (x-ray depths).
 */

import { parser } from '@lezer/rust';
import type {
  CodeModel,
  CodeUnit,
  Field,
  FlowArm,
  FlowNode,
  ImportEntry,
  Param,
  TypeRef,
  UnitKind,
} from './model';
import {
  IdAllocator,
  SkeletonPainter,
  Source,
  childNamed,
  children,
  collapse,
  containsNode,
  countErrors,
  cut,
  dedupe,
  docFromBlockComment,
  docFromLineComments,
  type SyntaxNode,
} from './source';

const ITEMS = [
  'FunctionItem',
  'StructItem',
  'EnumItem',
  'UnionItem',
  'TypeItem',
  'ConstItem',
  'StaticItem',
  'TraitItem',
  'ImplItem',
  'ModItem',
];
const PUNCT = ['{', '}', '(', ')', ',', ';', '|'];
const LOOPS = ['WhileExpression', 'LoopExpression', 'ForExpression'];
const CONTROL_EXPRS = [
  'IfExpression',
  'MatchExpression',
  ...LOOPS,
  'UnsafeBlock',
  'AsyncBlock',
  'Block',
];
const EXIT_KIND: Record<string, 'return' | 'break' | 'continue'> = {
  ReturnExpression: 'return',
  BreakExpression: 'break',
  ContinueExpression: 'continue',
};
/** Nodes whose text is a type (the child after `:` / `->`). */
const TYPE_NAMES = [
  'TypeIdentifier',
  'ScopedTypeIdentifier',
  'GenericType',
  'ReferenceType',
  'PointerType',
  'TupleType',
  'UnitType',
  'ArrayType',
  'FunctionType',
  'AbstractType',
  'DynamicType',
  'BoundedType',
  'EmptyType',
  'MacroInvocation',
];

interface Scope {
  /** `impl Foo` → methods are `impl Foo::bar`; `Mod` → `Mod::item`. */
  prefix: string | null;
  /** Inside a trait impl every method is public; inside a trait, as the trait. */
  forceExported: boolean;
  /** Functions are methods inside impl and trait blocks. */
  methods: boolean;
}

export function extractRust(text: string): CodeModel {
  const tree = parser.parse(text);
  const x = new RustExtractor(new Source(text));
  const units = x.itemsOf(tree.topNode, { prefix: null, forceExported: false, methods: false });
  const identifiers = dedupe(x.identifiers.filter((n) => /^\w+$/.test(n) && n !== 'self'));
  return {
    language: 'rust',
    units,
    imports: [
      { kind: 'internal', entries: x.imports.filter((e) => isInternal(e.source)) },
      { kind: 'package', entries: x.imports.filter((e) => !isInternal(e.source)) },
    ],
    identifiers,
    parseErrors: countErrors(tree),
  };
}

function isInternal(source: string): boolean {
  return /^(crate|super|self)(::|$)/.test(source);
}

class RustExtractor {
  readonly imports: ImportEntry[] = [];
  readonly identifiers: string[] = [];
  private readonly ids = new IdAllocator();

  constructor(private readonly src: Source) {}

  /* ---- items ----------------------------------------------------------- */

  itemsOf(container: SyntaxNode, scope: Scope): CodeUnit[] {
    const units: CodeUnit[] = [];
    for (const stmt of children(container)) {
      if (stmt.name === 'UseDeclaration' || stmt.name === 'ExternCrateDeclaration') {
        this.importOf(stmt);
        continue;
      }
      const item = stmt.name === 'AttributeItem' ? childNamed(stmt, ...ITEMS) : stmt;
      if (item && ITEMS.includes(item.name)) {
        const unit = this.itemUnit(item, stmt, scope);
        if (unit) {
          units.push(unit);
        }
      }
    }
    return units;
  }

  private importOf(stmt: SyntaxNode): void {
    const raw = collapse(this.src.nodeText(stmt))
      .replace(/^pub(\([^)]*\))?\s+/, '')
      .replace(/^(use|extern crate)\s+/, '')
      .replace(/;$/, '')
      .trim();
    const entry: ImportEntry = {
      source: '',
      names: [],
      line: this.src.lineAt(stmt.from),
      typeOnly: false,
    };
    const brace = raw.indexOf('{');
    if (brace >= 0) {
      entry.source = raw.slice(0, brace).replace(/::$/, '');
      entry.names = namesInUseList(raw.slice(brace));
    } else if (raw.endsWith('::*')) {
      entry.source = raw.slice(0, -3);
      entry.names = ['*'];
    } else {
      const asMatch = /^(.*?)\s+as\s+(\w+)$/.exec(raw);
      const path = asMatch ? asMatch[1]! : raw;
      const segments = path.split('::');
      const last = segments.pop() ?? path;
      entry.source = segments.length > 0 ? segments.join('::') : last;
      entry.names = [asMatch ? asMatch[2]! : last];
    }
    // `use std::io::{self, Write}` binds `io`, the source's own last segment.
    const own = entry.source.split('::').pop() ?? entry.source;
    entry.names = entry.names.map((n) => (n === 'self' ? own : n));
    this.imports.push(entry);
  }

  private itemUnit(item: SyntaxNode, outer: SyntaxNode, scope: Scope): CodeUnit | null {
    const exported = scope.forceExported || childNamed(item, 'Vis') !== null;
    switch (item.name) {
      case 'FunctionItem':
        return this.functionUnit(item, outer, exported, scope);
      case 'StructItem':
      case 'UnionItem':
        return this.structUnit(item, outer, exported, scope);
      case 'EnumItem':
        return this.enumUnit(item, outer, exported, scope);
      case 'TypeItem':
      case 'ConstItem':
      case 'StaticItem':
        return this.valueUnit(item, outer, exported, scope);
      case 'TraitItem':
        return this.traitUnit(item, outer, exported, scope);
      case 'ImplItem':
        return this.implUnit(item, outer, scope);
      case 'ModItem':
        return this.modUnit(item, outer, exported, scope);
      default:
        return null;
    }
  }

  private functionUnit(
    item: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    scope: Scope,
  ): CodeUnit {
    const name = this.nameOf(item, 'BoundIdentifier') ?? '?';
    const body = childNamed(item, 'Block');
    const arrow = childNamed(item, '->');
    const retType = arrow ? arrow.nextSibling : null;
    return this.build({
      kind: scope.methods ? 'method' : 'function',
      name,
      qualifiedName: qualify(scope.prefix, name),
      exported,
      async: childNamed(item, 'async') !== null,
      item,
      outer,
      sigEnd: body ? body.from : item.to,
      params: this.paramsOf(childNamed(item, 'ParamList')),
      returns: retType && TYPE_NAMES.includes(retType.name) ? this.typeRefOf(retType) : null,
      body,
    });
  }

  private structUnit(
    item: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    scope: Scope,
  ): CodeUnit {
    const name = this.nameOf(item, 'TypeIdentifier') ?? '?';
    const list = childNamed(item, 'FieldDeclarationList', 'OrderedFieldDeclarationList');
    return this.build({
      kind: 'struct',
      name,
      qualifiedName: qualify(scope.prefix, name),
      exported,
      async: false,
      item,
      outer,
      sigEnd: list ? list.from : item.to,
      params: [],
      returns: null,
      body: null,
      fields: list ? this.fieldsOf(list) : [],
    });
  }

  private enumUnit(item: SyntaxNode, outer: SyntaxNode, exported: boolean, scope: Scope): CodeUnit {
    const name = this.nameOf(item, 'TypeIdentifier') ?? '?';
    const list = childNamed(item, 'EnumVariantList');
    const fields: Field[] = [];
    if (list) {
      let docLines: string[] = [];
      for (const c of children(list)) {
        if (c.name === 'LineComment') {
          docLines.push(this.src.nodeText(c));
        } else if (c.name === 'EnumVariant') {
          const payload = childNamed(c, 'FieldDeclarationList', 'OrderedFieldDeclarationList');
          fields.push({
            name: this.nameOf(c, 'Identifier') ?? '?',
            type: payload ? collapse(this.src.nodeText(payload)) : null,
            optional: false,
            doc: docFromLineComments(docLines.filter((l) => l.startsWith('///'))),
            line: this.src.lineAt(c.from),
          });
          docLines = [];
        } else if (c.name !== 'Attribute') {
          docLines = [];
        }
      }
    }
    return this.build({
      kind: 'enum',
      name,
      qualifiedName: qualify(scope.prefix, name),
      exported,
      async: false,
      item,
      outer,
      sigEnd: list ? list.from : item.to,
      params: [],
      returns: null,
      body: null,
      fields,
    });
  }

  /** `type`, `const` and `static` items: a name with a type. */
  private valueUnit(
    item: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    scope: Scope,
  ): CodeUnit {
    const name = this.nameOf(item, 'TypeIdentifier') ?? this.nameOf(item, 'BoundIdentifier') ?? '?';
    const equals = childNamed(item, '=');
    const oneLine = this.src.lineAt(outer.from) === this.src.endLineOf(outer);
    // `type X = T` carries its type after `=`; `const X: T = …` after `:`.
    const type: SyntaxNode | null =
      item.name === 'TypeItem'
        ? (equals?.nextSibling ?? null)
        : (childNamed(item, ':')?.nextSibling ?? null);
    return this.build({
      kind: item.name === 'TypeItem' ? 'type' : 'const',
      name,
      qualifiedName: qualify(scope.prefix, name),
      exported,
      async: false,
      item,
      outer,
      sigEnd: oneLine ? item.to : (equals?.from ?? item.to),
      params: [],
      returns: type && TYPE_NAMES.includes(type.name) ? this.typeRefOf(type) : null,
      body: null,
    });
  }

  private traitUnit(
    item: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    scope: Scope,
  ): CodeUnit {
    const name = this.nameOf(item, 'TypeIdentifier') ?? '?';
    const qualifiedName = qualify(scope.prefix, name);
    const list = childNamed(item, 'DeclarationList');
    return this.build({
      kind: 'trait',
      name,
      qualifiedName,
      exported,
      async: false,
      item,
      outer,
      sigEnd: list ? list.from : item.to,
      params: [],
      returns: null,
      body: null,
      children: list
        ? this.itemsOf(list, { prefix: qualifiedName, forceExported: exported, methods: true })
        : [],
    });
  }

  private implUnit(item: SyntaxNode, outer: SyntaxNode, scope: Scope): CodeUnit {
    const list = childNamed(item, 'DeclarationList');
    const forKw = childNamed(item, 'for');
    const types = children(item).filter((c) => TYPE_NAMES.includes(c.name));
    const selfType = types[types.length - 1];
    const traitType = forKw ? types[0] : undefined;
    const selfText = selfType ? collapse(this.src.nodeText(selfType)) : '?';
    const name = traitType ? `${collapse(this.src.nodeText(traitType))} for ${selfText}` : selfText;
    const qualifiedName = qualify(scope.prefix, `impl ${name}`);
    return this.build({
      kind: 'impl',
      name,
      qualifiedName,
      exported: traitType !== undefined,
      async: false,
      item,
      outer,
      sigEnd: list ? list.from : item.to,
      params: [],
      returns: null,
      body: null,
      children: list
        ? this.itemsOf(list, {
            prefix: qualifiedName,
            forceExported: traitType !== undefined,
            methods: true,
          })
        : [],
    });
  }

  private modUnit(item: SyntaxNode, outer: SyntaxNode, exported: boolean, scope: Scope): CodeUnit {
    const name = this.nameOf(item, 'BoundIdentifier') ?? '?';
    const qualifiedName = qualify(scope.prefix, name);
    const list = childNamed(item, 'DeclarationList');
    return this.build({
      kind: 'module',
      name,
      qualifiedName,
      exported,
      async: false,
      item,
      outer,
      sigEnd: list ? list.from : item.to,
      params: [],
      returns: null,
      body: null,
      children: list
        ? this.itemsOf(list, { prefix: qualifiedName, forceExported: false, methods: false })
        : [],
    });
  }

  /* ---- the unit record --------------------------------------------------- */

  private build(o: {
    kind: UnitKind;
    name: string;
    qualifiedName: string;
    exported: boolean;
    async: boolean;
    item: SyntaxNode;
    outer: SyntaxNode;
    sigEnd: number;
    params: Param[];
    returns: TypeRef | null;
    body: SyntaxNode | null;
    fields?: Field[];
    children?: CodeUnit[];
  }): CodeUnit {
    const { doc, from } = this.docBefore(o.outer);
    const first = this.src.lineAt(from);
    const last = this.src.endLineOf(o.outer);
    const fields = o.fields ?? [];
    const signature = collapse(this.src.slice(o.item.from, o.sigEnd))
      .replace(/\s*(\{|=)$/, '')
      .replace(/;$/, '')
      .trim();

    const painter = new SkeletonPainter(this.src, first, last);
    this.paintDecl(o.outer, 0, painter);

    const calls: string[] = [];
    if (o.body) {
      this.collectCalls(o.body, calls);
    }
    const flow: FlowNode | null = o.body
      ? {
          kind: 'fn',
          line: this.src.lineAt(o.item.from),
          name: o.name,
          body: this.flowOfBlock(o.body),
        }
      : null;

    this.identifiers.push(o.name, ...fields.map((f) => f.name), ...o.params.map((p) => p.name));

    return {
      id: this.ids.next(o.kind, o.qualifiedName),
      kind: o.kind,
      name: o.name,
      qualifiedName: o.qualifiedName,
      exported: o.exported,
      async: o.async,
      lines: [first, last],
      signatureLine: this.src.lineAt(o.item.from),
      signature,
      params: o.params,
      returns: o.returns,
      doc,
      fields,
      calls: dedupe(calls),
      flow,
      children: o.children ?? [],
      skeleton: painter.build(),
    };
  }

  /* ---- names, docs, params, types ------------------------------------- */

  private nameOf(node: SyntaxNode, childName: string): string | null {
    const c = childNamed(node, childName);
    return c ? this.src.nodeText(c) : null;
  }

  /** The `///` run (or `/** *\/`) before `node`; attributes sit in between. */
  private docBefore(node: SyntaxNode): { doc: string | null; from: number } {
    const lines: string[] = [];
    let from = node.from;
    let prev = node.prevSibling;
    let cursorFrom = node.from;
    while (prev && this.src.blankBetween(prev.to, cursorFrom)) {
      const text = this.src.nodeText(prev);
      if (prev.name === 'LineComment' && text.startsWith('///')) {
        lines.unshift(text);
        from = prev.from;
      } else if (prev.name === 'BlockComment' && lines.length === 0) {
        const doc = docFromBlockComment(text);
        return doc === null ? { doc: null, from: node.from } : { doc, from: prev.from };
      } else {
        break;
      }
      cursorFrom = prev.from;
      prev = prev.prevSibling;
    }
    return { doc: lines.length > 0 ? docFromLineComments(lines) : null, from };
  }

  private paramsOf(list: SyntaxNode | null): Param[] {
    if (!list) {
      return [];
    }
    const params: Param[] = [];
    for (const c of children(list)) {
      if (c.name === 'SelfParameter') {
        const amp = childNamed(c, '&') !== null;
        const mut = childNamed(c, 'mut') !== null;
        params.push({
          name: 'self',
          type: collapse(this.src.nodeText(c)).replace(/\bself$/, 'Self'),
          optional: false,
          hasDefault: false,
          rest: false,
          ref: amp ? (mut ? 'mut' : 'ref') : 'none',
        });
      } else if (c.name === 'Parameter') {
        const colon = childNamed(c, ':');
        const type = colon?.nextSibling ?? null;
        const nameEnd = colon ? colon.from : c.to;
        const name = this.nameOf(c, 'BoundIdentifier') ?? collapse(this.src.slice(c.from, nameEnd));
        const typeText = type ? collapse(this.src.nodeText(type)) : null;
        params.push({
          name,
          type: typeText,
          optional: false,
          hasDefault: false,
          rest: false,
          ref: refOf(typeText),
        });
      }
    }
    return params;
  }

  private typeRefOf(type: SyntaxNode): TypeRef {
    return { text: collapse(this.src.nodeText(type)), fields: null };
  }

  private fieldsOf(list: SyntaxNode): Field[] {
    const out: Field[] = [];
    if (list.name === 'OrderedFieldDeclarationList') {
      let index = 0;
      for (const c of children(list)) {
        if (TYPE_NAMES.includes(c.name)) {
          out.push({
            name: String(index),
            type: collapse(this.src.nodeText(c)),
            optional: false,
            doc: null,
            line: this.src.lineAt(c.from),
          });
          index += 1;
        }
      }
      return out;
    }
    let docLines: string[] = [];
    for (const c of children(list)) {
      if (c.name === 'LineComment') {
        docLines.push(this.src.nodeText(c));
      } else if (c.name === 'FieldDeclaration') {
        const colon = childNamed(c, ':');
        const type = colon?.nextSibling ?? null;
        out.push({
          name: this.nameOf(c, 'FieldIdentifier') ?? '?',
          type: type ? collapse(this.src.nodeText(type)) : null,
          optional: false,
          doc: docFromLineComments(docLines.filter((l) => l.startsWith('///'))),
          line: this.src.lineAt(c.from),
        });
        docLines = [];
      } else if (c.name !== 'Attribute') {
        docLines = [];
      }
    }
    return out;
  }

  /* ---- calls ------------------------------------------------------------- */

  private collectCalls(node: SyntaxNode, out: string[]): void {
    for (const c of children(node)) {
      if (c.name === 'CallExpression') {
        const callee = c.firstChild;
        const text = callee ? this.calleeText(callee) : null;
        if (text) {
          out.push(text);
        }
      } else if (c.name === 'MacroInvocation') {
        const path = childNamed(c, 'Identifier', 'ScopedIdentifier');
        if (path) {
          out.push(`${collapse(this.src.nodeText(path))}!`);
        }
      }
      this.collectCalls(c, out);
    }
  }

  private calleeText(callee: SyntaxNode): string | null {
    const text = collapse(this.src.nodeText(callee)).replace(/::<[^<>]*>/g, '');
    if (
      callee.name === 'Identifier' ||
      callee.name === 'ScopedIdentifier' ||
      callee.name === 'GenericFunction'
    ) {
      return /^[\w:]+$/.test(text) ? text : null;
    }
    if (callee.name === 'FieldExpression') {
      if (/^\w+(\.\w+)+$/.test(text)) {
        return text;
      }
      const field = childNamed(callee, 'FieldIdentifier');
      return field ? `.${this.src.nodeText(field)}` : null;
    }
    return null;
  }

  /* ---- control flow ------------------------------------------------------ */

  private flowOfBlock(block: SyntaxNode): FlowNode[] {
    return this.flowOfStmts(children(block).filter((c) => !PUNCT.includes(c.name)));
  }

  private flowOfStmts(stmts: readonly SyntaxNode[]): FlowNode[] {
    const out: FlowNode[] = [];
    let seq: { kind: 'seq'; lines: [number, number]; items: string[] } | null = null;
    for (const s of stmts) {
      if (s.name === 'LineComment' || s.name === 'BlockComment' || s.name === 'EmptyStatement') {
        continue;
      }
      const nodes = this.stmtFlow(s);
      if (nodes === null) {
        const line = this.src.lineAt(s.from);
        if (!seq) {
          seq = { kind: 'seq', lines: [line, line], items: [] };
          out.push(seq);
        }
        seq.lines[1] = this.src.endLineOf(s);
        seq.items.push(this.stmtText(s));
        // `expr?` leaves the function on an error — an early exit that a
        // reader of the chart must see.
        if (containsNode(s, ['TryExpression'], ['ClosureExpression'])) {
          seq = null;
          out.push({ kind: 'throw', line, text: this.stmtText(s), conditional: true });
        }
      } else {
        seq = null;
        out.push(...nodes);
      }
    }
    return out;
  }

  private stmtText(s: SyntaxNode): string {
    return cut(
      this.src
        .nodeText(s)
        .replace(/^let\s+(mut\s+)?/, '')
        .replace(/;\s*$/, ''),
    );
  }

  private stmtFlow(s: SyntaxNode): FlowNode[] | null {
    const line = this.src.lineAt(s.from);
    if (s.name === 'ExpressionStatement') {
      const e = s.firstChild;
      return e ? this.exprFlow(e) : null;
    }
    if (s.name === 'LetDeclaration') {
      const equals = childNamed(s, '=');
      const value = equals?.nextSibling ?? null;
      if (!value) {
        return null;
      }
      if (value.name === 'ClosureExpression') {
        const body = childNamed(value, 'Block');
        return body
          ? [
              {
                kind: 'fn',
                line,
                name: this.nameOf(s, 'BoundIdentifier') ?? 'closure',
                body: this.flowOfBlock(body),
              },
            ]
          : null;
      }
      return this.exprFlow(value);
    }
    if (s.name === 'FunctionItem') {
      const body = childNamed(s, 'Block');
      return [
        {
          kind: 'fn',
          line,
          name: this.nameOf(s, 'BoundIdentifier') ?? 'fn',
          body: body ? this.flowOfBlock(body) : [],
        },
      ];
    }
    return null;
  }

  private exprFlow(e: SyntaxNode): FlowNode[] | null {
    const line = this.src.lineAt(e.from);
    switch (e.name) {
      case 'IfExpression': {
        const ifKw = childNamed(e, 'if');
        const block = childNamed(e, 'Block');
        const elseKw = childNamed(e, 'else');
        const alternate = elseKw?.nextSibling ?? null;
        return [
          {
            kind: 'if',
            line,
            cond: ifKw && block ? cut(this.src.slice(ifKw.to, block.from)) : '',
            then: block ? this.flowOfBlock(block) : [],
            else: alternate ? (this.exprFlow(alternate) ?? []) : null,
          },
        ];
      }
      case 'MatchExpression': {
        const kw = childNamed(e, 'match');
        const block = childNamed(e, 'MatchBlock');
        const arms: FlowArm[] = [];
        for (const arm of block ? children(block) : []) {
          if (arm.name !== 'MatchArm') {
            continue;
          }
          const arrow = childNamed(arm, '=>');
          const body = arrow?.nextSibling ?? null;
          const label = cut(this.src.slice(arm.from, arrow ? arrow.from : arm.to));
          arms.push({ label, body: body ? this.armBody(body) : [] });
        }
        return [
          {
            kind: 'switch',
            line,
            subject: kw && block ? cut(this.src.slice(kw.to, block.from)) : '',
            arms,
          },
        ];
      }
      case 'WhileExpression':
      case 'LoopExpression':
      case 'ForExpression': {
        const block = childNamed(e, 'Block');
        return [
          {
            kind: 'loop',
            line,
            header: cut(this.src.slice(e.from, block ? block.from : e.to)),
            body: block ? this.flowOfBlock(block) : [],
          },
        ];
      }
      case 'ReturnExpression':
      case 'BreakExpression':
      case 'ContinueExpression': {
        const text = cut(this.src.nodeText(e).replace(/^(return|break|continue)\b\s*/, ''));
        return [{ kind: EXIT_KIND[e.name]!, line, text, conditional: false }];
      }
      case 'Block':
        return this.flowOfBlock(e);
      case 'UnsafeBlock':
      case 'AsyncBlock': {
        const block = childNamed(e, 'Block');
        return block ? this.flowOfBlock(block) : [];
      }
      default:
        return null;
    }
  }

  /** A match arm's body: a block's statements or the single expression. */
  private armBody(body: SyntaxNode): FlowNode[] {
    if (body.name === 'Block') {
      return this.flowOfBlock(body);
    }
    const nodes = this.exprFlow(body);
    if (nodes) {
      return nodes;
    }
    const line = this.src.lineAt(body.from);
    const out: FlowNode[] = [
      {
        kind: 'seq',
        lines: [line, this.src.endLineOf(body)],
        items: [cut(this.src.nodeText(body))],
      },
    ];
    if (
      body.name === 'TryExpression' ||
      containsNode(body, ['TryExpression'], ['ClosureExpression'])
    ) {
      out.push({ kind: 'throw', line, text: cut(this.src.nodeText(body)), conditional: true });
    }
    return out;
  }

  /* ---- x-ray depths ------------------------------------------------------ */

  private paintDecl(node: SyntaxNode, d: number, p: SkeletonPainter): void {
    const first = this.src.lineAt(node.from);
    const last = this.src.endLineOf(node);
    const item = node.name === 'AttributeItem' ? (childNamed(node, ...ITEMS) ?? node) : node;
    const body = childNamed(
      item,
      'Block',
      'DeclarationList',
      'FieldDeclarationList',
      'EnumVariantList',
    );
    if (!body) {
      p.range(first, last, d);
      return;
    }
    p.range(first, this.src.lineAt(body.from), d);
    p.line(this.src.endLineOf(body), d);
    if (body.name === 'Block') {
      this.paintBlock(body, d + 1, p);
    } else if (body.name === 'DeclarationList') {
      this.paintDeclList(body, d + 1, p);
    } else {
      p.range(this.src.lineAt(body.from) + 1, this.src.endLineOf(body) - 1, d + 1);
    }
  }

  /** impl / trait / mod bodies: members are declarations at depth `d`. */
  private paintDeclList(list: SyntaxNode, d: number, p: SkeletonPainter): void {
    p.range(this.src.lineAt(list.from) + 1, this.src.endLineOf(list) - 1, d + 1);
    for (const m of children(list)) {
      const item = m.name === 'AttributeItem' ? childNamed(m, ...ITEMS) : m;
      if (item && ITEMS.includes(item.name)) {
        this.paintDecl(m, d, p);
      } else if (m.name === 'LineComment' || m.name === 'BlockComment') {
        p.range(this.src.lineAt(m.from), this.src.endLineOf(m), d);
      }
    }
  }

  private paintBlock(block: SyntaxNode, d: number, p: SkeletonPainter): void {
    p.range(this.src.lineAt(block.from) + 1, this.src.endLineOf(block) - 1, d + 1);
    for (const s of children(block)) {
      if (!PUNCT.includes(s.name)) {
        this.paintStmt(s, d, p);
      }
    }
  }

  private paintStmt(s: SyntaxNode, d: number, p: SkeletonPainter): void {
    const first = this.src.lineAt(s.from);
    const last = this.src.endLineOf(s);
    if (s.name === 'ExpressionStatement') {
      const e = s.firstChild;
      if (e && e.name in EXIT_KIND) {
        p.range(first, last, d);
        return;
      }
      if (e && CONTROL_EXPRS.includes(e.name)) {
        this.paintControl(e, d, p, first);
        return;
      }
    } else if (s.name === 'LetDeclaration') {
      const value = childNamed(s, '=')?.nextSibling ?? null;
      if (value && CONTROL_EXPRS.includes(value.name)) {
        this.paintControl(value, d, p, first);
        return;
      }
      if (value?.name === 'ClosureExpression' && childNamed(value, 'Block')) {
        this.paintControl(value, d, p, first);
        return;
      }
    } else if (s.name === 'FunctionItem' || s.name === 'AttributeItem') {
      this.paintDecl(s, d, p);
      return;
    }
    p.range(first, last, d + 1);
  }

  /**
   * A control expression at depth `d`: header lines through the opening
   * brace stay at `d`, braces at `d`, the body one level down; `else` chains
   * and match arms continue at the same depth.
   */
  private paintControl(e: SyntaxNode, d: number, p: SkeletonPainter, headerFrom: number): void {
    const last = this.src.endLineOf(e);
    p.range(headerFrom, last, d + 1);
    const firstBody = childNamed(e, 'Block', 'MatchBlock');
    p.range(headerFrom, firstBody ? this.src.lineAt(firstBody.from) : last, d);
    for (const c of children(e)) {
      if (c.name === 'Block') {
        p.line(this.src.lineAt(c.from), d);
        p.line(this.src.endLineOf(c), d);
        this.paintBlock(c, d + 1, p);
      } else if (c.name === 'IfExpression') {
        this.paintControl(c, d, p, this.src.lineAt(c.from));
      } else if (c.name === 'MatchBlock') {
        p.line(this.src.lineAt(c.from), d);
        p.line(this.src.endLineOf(c), d);
        p.range(this.src.lineAt(c.from) + 1, this.src.endLineOf(c) - 1, d + 2);
        for (const arm of children(c)) {
          if (arm.name !== 'MatchArm') {
            continue;
          }
          const armFirst = this.src.lineAt(arm.from);
          p.range(armFirst, this.src.endLineOf(arm), d + 2);
          const body = childNamed(arm, '=>')?.nextSibling ?? null;
          if (body?.name === 'Block') {
            p.range(armFirst, this.src.lineAt(body.from), d + 1);
            p.line(this.src.endLineOf(body), d + 1);
            this.paintBlock(body, d + 2, p);
          } else {
            p.line(armFirst, d + 1);
          }
        }
      }
    }
  }
}

/* ---- helpers --------------------------------------------------------------- */

function qualify(prefix: string | null, name: string): string {
  return prefix ? `${prefix}::${name}` : name;
}

function refOf(type: string | null): 'none' | 'ref' | 'mut' {
  if (!type || !type.startsWith('&')) {
    return 'none';
  }
  return /^&\s*(?:'\w+\s+)?mut\b/.test(type) ? 'mut' : 'ref';
}

/** Bound names of a `{…}` use list, nested lists flattened. */
function namesInUseList(list: string): string[] {
  const inner = list.trim().replace(/^\{/, '').replace(/\}$/, '');
  const names: string[] = [];
  let depth = 0;
  let cur = '';
  const flush = () => {
    const part = cur.trim();
    cur = '';
    if (!part) {
      return;
    }
    const brace = part.indexOf('{');
    if (brace >= 0) {
      names.push(...namesInUseList(part.slice(brace)));
      return;
    }
    const asMatch = /\s+as\s+(\w+)$/.exec(part);
    if (asMatch) {
      names.push(asMatch[1]!);
      return;
    }
    names.push(part.split('::').pop() ?? part);
  };
  for (const ch of inner) {
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return names;
}
