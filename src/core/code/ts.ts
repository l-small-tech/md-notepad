/**
 * TypeScript / JavaScript extractor: Lezer tree → {@link CodeModel}. This file
 * (with `rust.ts`) is the only place that knows `@lezer/javascript` node
 * names; nothing downstream may depend on them.
 *
 * Reading order: `extractTs` parses and walks the top level; `declUnits`
 * turns one declaration into units; the three concerns per unit — params /
 * fields (form data), `flowOf*` (control-flow tree) and `paint*` (x-ray
 * depths) — are separate walks over the same subtree, each small enough to
 * read on its own.
 */

import { parser } from '@lezer/javascript';
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
  countErrors,
  cut,
  dedupe,
  docFromBlockComment,
  type SyntaxNode,
} from './source';

export interface TsFlavor {
  /** Parse with the TypeScript dialect (types, interfaces, enums…). */
  ts: boolean;
  /** Allow JSX. */
  jsx: boolean;
}

const DECLARATIONS = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'TypeAliasDeclaration',
  'InterfaceDeclaration',
  'EnumDeclaration',
  'NamespaceDeclaration',
];

const CONTROL = [
  'IfStatement',
  'ForStatement',
  'WhileStatement',
  'DoStatement',
  'SwitchStatement',
  'TryStatement',
  'LabeledStatement',
  'Block',
];
const EXITS = ['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'];
const EXIT_KIND: Record<string, 'return' | 'throw' | 'break' | 'continue'> = {
  ReturnStatement: 'return',
  ThrowStatement: 'throw',
  BreakStatement: 'break',
  ContinueStatement: 'continue',
};
const PUNCT = ['{', '}', '(', ')', ',', ';'];
const FUNCTION_VALUES = ['ArrowFunction', 'FunctionExpression'];

export function extractTs(text: string, flavor: TsFlavor): CodeModel {
  const dialect = [flavor.jsx ? 'jsx' : '', flavor.ts ? 'ts' : ''].filter(Boolean).join(' ');
  const tree = parser.configure({ dialect }).parse(text);
  const x = new TsExtractor(new Source(text));
  const units = x.unitsOf(tree.topNode, null);
  x.applyExportGroups(units);
  const identifiers = dedupe(x.identifiers.filter((n) => /^[\w$#]+$/.test(n)));
  return {
    language: 'ts',
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
  return /^(\.|\/|~\/|@\/|#)/.test(source);
}

class TsExtractor {
  readonly imports: ImportEntry[] = [];
  readonly identifiers: string[] = [];
  private readonly exportedNames = new Set<string>();
  private readonly ids = new IdAllocator();

  constructor(private readonly src: Source) {}

  /* ---- top level ------------------------------------------------------- */

  unitsOf(container: SyntaxNode, parent: string | null): CodeUnit[] {
    const units: CodeUnit[] = [];
    for (const stmt of children(container)) {
      switch (stmt.name) {
        case 'ImportDeclaration':
          this.importOf(stmt);
          break;
        case 'ExportDeclaration': {
          const decl = childNamed(stmt, ...DECLARATIONS);
          if (decl) {
            units.push(...this.declUnits(decl, stmt, true, parent));
          } else if (childNamed(stmt, 'String')) {
            this.reexportOf(stmt);
          } else {
            const group = childNamed(stmt, 'ExportGroup');
            if (group) {
              this.exportGroupOf(group);
            }
          }
          break;
        }
        case 'AmbientDeclaration': {
          const decl = childNamed(stmt, ...DECLARATIONS);
          if (decl) {
            units.push(...this.declUnits(decl, stmt, false, parent));
          }
          break;
        }
        default:
          if (DECLARATIONS.includes(stmt.name)) {
            units.push(...this.declUnits(stmt, stmt, false, parent));
          }
      }
    }
    return units;
  }

  /** `export { a as b }` — the local `a` is exported. Applied after the walk. */
  private exportGroupOf(group: SyntaxNode): void {
    let afterAs = false;
    for (const c of children(group)) {
      if (c.name === 'as') {
        afterAs = true;
      } else if (c.name === 'VariableName') {
        if (!afterAs) {
          this.exportedNames.add(this.src.nodeText(c));
        }
        afterAs = false;
      } else if (c.name === ',') {
        afterAs = false;
      }
    }
  }

  applyExportGroups(units: CodeUnit[]): void {
    for (const u of units) {
      if (this.exportedNames.has(u.name)) {
        u.exported = true;
      }
    }
  }

  private importOf(stmt: SyntaxNode): void {
    const source = childNamed(stmt, 'String');
    if (!source) {
      return;
    }
    const names: string[] = [];
    let star = false;
    for (const c of children(stmt)) {
      if (c.name === 'Star') {
        star = true;
      } else if (c.name === 'VariableDefinition') {
        names.push(star ? `* as ${this.src.nodeText(c)}` : this.src.nodeText(c));
        star = false;
      } else if (c.name === 'ImportGroup') {
        for (const d of children(c)) {
          if (d.name === 'VariableDefinition') {
            names.push(this.src.nodeText(d));
          }
        }
      }
    }
    this.imports.push({
      source: unquote(this.src.nodeText(source)),
      names,
      line: this.src.lineAt(stmt.from),
      typeOnly: childNamed(stmt, 'type') !== null,
    });
  }

  /** `export * from './x'` / `export { a } from './y'` — a dependency too. */
  private reexportOf(stmt: SyntaxNode): void {
    const source = childNamed(stmt, 'String')!;
    const names: string[] = [];
    if (childNamed(stmt, 'Star')) {
      names.push('*');
    }
    const group = childNamed(stmt, 'ExportGroup');
    if (group) {
      let afterAs = false;
      for (const c of children(group)) {
        if (c.name === 'as') {
          afterAs = true;
        } else if (c.name === 'VariableName') {
          if (!afterAs) {
            names.push(this.src.nodeText(c));
          }
          afterAs = false;
        } else if (c.name === ',') {
          afterAs = false;
        }
      }
    }
    this.imports.push({
      source: unquote(this.src.nodeText(source)),
      names,
      line: this.src.lineAt(stmt.from),
      typeOnly: childNamed(stmt, 'type') !== null,
    });
  }

  /* ---- declarations → units -------------------------------------------- */

  private declUnits(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit[] {
    switch (decl.name) {
      case 'FunctionDeclaration':
        return [this.functionUnit(decl, outer, exported, parent)];
      case 'ClassDeclaration':
        return [this.classUnit(decl, outer, exported, parent)];
      case 'VariableDeclaration':
        return this.variableUnits(decl, outer, exported, parent);
      case 'TypeAliasDeclaration':
        return [this.typeAliasUnit(decl, outer, exported, parent)];
      case 'InterfaceDeclaration':
        return [this.interfaceUnit(decl, outer, exported, parent)];
      case 'EnumDeclaration':
        return [this.enumUnit(decl, outer, exported, parent)];
      case 'NamespaceDeclaration':
        return [this.namespaceUnit(decl, outer, exported, parent)];
      default:
        return [];
    }
  }

  private functionUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'VariableDefinition') ?? 'default';
    const body = childNamed(decl, 'Block');
    return this.build({
      kind: 'function',
      name,
      qualifiedName: qualify(parent, name),
      exported,
      async: childNamed(decl, 'async') !== null,
      decl,
      outer,
      sigEnd: body ? body.from : outer.to,
      params: this.paramsOf(childNamed(decl, 'ParamList')),
      returns: this.returnsOf(decl),
      body,
    });
  }

  private variableUnits(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit[] {
    // One VariableDeclaration may declare several names; each is a unit.
    interface Declarator {
      nameNode: SyntaxNode;
      type: SyntaxNode | null;
      equals: SyntaxNode | null;
      value: SyntaxNode | null;
    }
    const declarators: Declarator[] = [];
    let cur: Declarator | null = null;
    for (const c of children(decl)) {
      if (
        ['VariableDefinition', 'ObjectPattern', 'ArrayPattern'].includes(c.name) &&
        !cur?.equals
      ) {
        cur = { nameNode: c, type: null, equals: null, value: null };
        declarators.push(cur);
      } else if (c.name === 'TypeAnnotation' && cur && !cur.equals) {
        cur.type = c;
      } else if (c.name === 'Equals' && cur) {
        cur.equals = c;
      } else if (c.name === ',') {
        cur = null;
      } else if (cur?.equals && !cur.value && !PUNCT.includes(c.name)) {
        cur.value = c;
      }
    }
    const single = declarators.length === 1;
    return declarators.map((d) => {
      const name = collapse(this.src.nodeText(d.nameNode));
      const fn = d.value && FUNCTION_VALUES.includes(d.value.name) ? d.value : null;
      if (fn) {
        const body = childNamed(fn, 'Block');
        const arrow = childNamed(fn, 'Arrow');
        return this.build({
          kind: 'function',
          name,
          qualifiedName: qualify(parent, name),
          exported,
          async: childNamed(fn, 'async') !== null,
          decl,
          outer,
          sigEnd: body ? body.from : arrow ? arrow.to : fn.to,
          params: this.paramsOf(childNamed(fn, 'ParamList')),
          returns: this.returnsOf(fn),
          body: body ?? (arrow ? nodeAfter(fn, arrow) : null),
        });
      }
      const oneLine = this.src.lineAt(outer.from) === this.src.endLineOf(outer);
      return this.build({
        kind: 'const',
        name,
        qualifiedName: qualify(parent, name),
        exported,
        async: false,
        decl,
        outer,
        sigEnd: oneLine && single ? outer.to : (d.equals?.from ?? outer.to),
        params: [],
        returns: d.type ? this.typeRefOf(d.type) : null,
        body: null,
      });
    });
  }

  private classUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'VariableDefinition') ?? 'default';
    const qualifiedName = qualify(parent, name);
    const body = childNamed(decl, 'ClassBody');
    const fields: Field[] = [];
    const members: CodeUnit[] = [];
    if (body) {
      for (const m of children(body)) {
        if (m.name === 'PropertyDeclaration') {
          const pname =
            this.nameOf(m, 'PropertyDefinition') ?? this.nameOf(m, 'PrivatePropertyDefinition');
          if (pname) {
            const type = childNamed(m, 'TypeAnnotation');
            fields.push({
              name: pname,
              type: type ? this.typeText(type) : null,
              optional: childNamed(m, 'Optional') !== null,
              doc: this.docBefore(m).doc,
              line: this.src.lineAt(m.from),
            });
          }
        } else if (m.name === 'MethodDeclaration') {
          const mname =
            this.nameOf(m, 'PropertyDefinition') ??
            this.nameOf(m, 'PrivatePropertyDefinition') ??
            '?';
          const privacy = childNamed(m, 'Privacy');
          const hidden =
            mname.startsWith('#') || (privacy !== null && this.src.nodeText(privacy) !== 'public');
          const mbody = childNamed(m, 'Block');
          if (mname === 'constructor') {
            fields.push(...this.constructorFields(childNamed(m, 'ParamList')));
          }
          members.push(
            this.build({
              kind: 'method',
              name: mname,
              qualifiedName: `${qualifiedName}.${mname}`,
              exported: exported && !hidden,
              async: childNamed(m, 'async') !== null,
              decl: m,
              outer: m,
              sigEnd: mbody ? mbody.from : m.to,
              params: this.paramsOf(childNamed(m, 'ParamList')),
              returns: this.returnsOf(m),
              body: mbody,
            }),
          );
        }
      }
    }
    return this.build({
      kind: 'class',
      name,
      qualifiedName,
      exported,
      async: false,
      decl,
      outer,
      sigEnd: body ? body.from : outer.to,
      params: [],
      returns: null,
      body: null,
      fields,
      children: members,
    });
  }

  /** `constructor(public a: string)` declares a field. */
  private constructorFields(list: SyntaxNode | null): Field[] {
    if (!list) {
      return [];
    }
    const out: Field[] = [];
    let modified = false;
    let cur: Field | null = null;
    for (const c of children(list)) {
      if (c.name === 'Privacy' || c.name === 'readonly') {
        modified = true;
      } else if (c.name === 'VariableDefinition') {
        if (modified) {
          cur = {
            name: this.src.nodeText(c),
            type: null,
            optional: false,
            doc: null,
            line: this.src.lineAt(c.from),
          };
          out.push(cur);
        }
        modified = false;
      } else if (c.name === 'TypeAnnotation' && cur) {
        cur.type = this.typeText(c);
      } else if (c.name === 'Optional' && cur) {
        cur.optional = true;
      } else if (c.name === ',') {
        cur = null;
      }
    }
    return out;
  }

  private interfaceUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'TypeDefinition') ?? '?';
    const body = childNamed(decl, 'ObjectType');
    return this.build({
      kind: 'interface',
      name,
      qualifiedName: qualify(parent, name),
      exported,
      async: false,
      decl,
      outer,
      sigEnd: body ? body.from : outer.to,
      params: [],
      returns: null,
      body: null,
      fields: body ? this.objectTypeFields(body) : [],
    });
  }

  private typeAliasUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'TypeDefinition') ?? '?';
    const equals = childNamed(decl, 'Equals');
    const type = equals ? nodeAfter(decl, equals) : null;
    const oneLine = this.src.lineAt(outer.from) === this.src.endLineOf(outer);
    return this.build({
      kind: 'type',
      name,
      qualifiedName: qualify(parent, name),
      exported,
      async: false,
      decl,
      outer,
      sigEnd: oneLine ? outer.to : (equals?.from ?? outer.to),
      params: [],
      returns: type ? this.typeRefOfNode(type) : null,
      body: null,
      fields: type?.name === 'ObjectType' ? this.objectTypeFields(type) : [],
    });
  }

  private enumUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'TypeDefinition') ?? '?';
    const body = childNamed(decl, 'EnumBody');
    const fields: Field[] = [];
    if (body) {
      let doc: string | null = null;
      for (const c of children(body)) {
        if (c.name === 'BlockComment') {
          doc = docFromBlockComment(this.src.nodeText(c));
        } else if (c.name === 'PropertyName' || c.name === 'String') {
          fields.push({
            name: unquote(this.src.nodeText(c)),
            type: null,
            optional: false,
            doc,
            line: this.src.lineAt(c.from),
          });
          doc = null;
        } else if (!PUNCT.includes(c.name) && c.name !== 'Equals' && fields.length > 0) {
          fields[fields.length - 1]!.type = collapse(this.src.nodeText(c));
        }
      }
    }
    return this.build({
      kind: 'enum',
      name,
      qualifiedName: qualify(parent, name),
      exported,
      async: false,
      decl,
      outer,
      sigEnd: body ? body.from : outer.to,
      params: [],
      returns: null,
      body: null,
      fields,
    });
  }

  private namespaceUnit(
    decl: SyntaxNode,
    outer: SyntaxNode,
    exported: boolean,
    parent: string | null,
  ): CodeUnit {
    const name = this.nameOf(decl, 'VariableDefinition') ?? '?';
    const qualifiedName = qualify(parent, name);
    const body = childNamed(decl, 'Block');
    return this.build({
      kind: 'module',
      name,
      qualifiedName,
      exported,
      async: false,
      decl,
      outer,
      sigEnd: body ? body.from : outer.to,
      params: [],
      returns: null,
      body: null,
      children: body ? this.unitsOf(body, qualifiedName) : [],
    });
  }

  /* ---- the unit record --------------------------------------------------- */

  private build(o: {
    kind: UnitKind;
    name: string;
    qualifiedName: string;
    exported: boolean;
    async: boolean;
    decl: SyntaxNode;
    outer: SyntaxNode;
    sigEnd: number;
    params: Param[];
    returns: TypeRef | null;
    /** A Block, or an expression body (arrow function), or null. */
    body: SyntaxNode | null;
    fields?: Field[];
    children?: CodeUnit[];
  }): CodeUnit {
    const { doc, from } = this.docBefore(o.outer);
    const first = this.src.lineAt(from);
    const last = this.src.endLineOf(o.outer);
    const fields = o.fields ?? [];
    const signature = collapse(this.src.slice(o.outer.from, o.sigEnd))
      .replace(/\s*(=>|\{|=)$/, '')
      .replace(/;$/, '')
      .trim();

    const painter = new SkeletonPainter(this.src, first, last);
    this.paintDecl(o.outer, 0, painter);

    const calls: string[] = [];
    if (o.body) {
      this.collectCalls(o.body, calls);
    }
    let flow: FlowNode | null = null;
    if (o.body) {
      const line = this.src.lineAt(o.decl.from);
      const body =
        o.body.name === 'Block'
          ? this.flowOfBlock(o.body)
          : [
              {
                kind: 'return' as const,
                line: this.src.lineAt(o.body.from),
                text: cut(this.src.nodeText(o.body)),
                conditional: false,
              },
            ];
      flow = { kind: 'fn', line, name: o.name, body };
    }

    this.identifiers.push(o.name, ...fields.map((f) => f.name), ...o.params.map((p) => p.name));

    return {
      id: this.ids.next(o.kind, o.qualifiedName),
      kind: o.kind,
      name: o.name,
      qualifiedName: o.qualifiedName,
      exported: o.exported,
      async: o.async,
      lines: [first, last],
      signatureLine: this.src.lineAt(o.decl.from),
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

  /** The `/** … *\/` immediately before `node` (whitespace only between). */
  private docBefore(node: SyntaxNode): { doc: string | null; from: number } {
    const prev = node.prevSibling;
    if (prev && prev.name === 'BlockComment' && this.src.blankBetween(prev.to, node.from)) {
      const doc = docFromBlockComment(this.src.nodeText(prev));
      if (doc !== null) {
        return { doc, from: prev.from };
      }
    }
    return { doc: null, from: node.from };
  }

  private paramsOf(list: SyntaxNode | null): Param[] {
    if (!list) {
      return [];
    }
    const params: Param[] = [];
    let cur: Param | null = null;
    let rest = false;
    for (const c of children(list)) {
      switch (c.name) {
        case ',':
          cur = null;
          break;
        case 'Spread':
          rest = true;
          break;
        case 'VariableDefinition':
        case 'ObjectPattern':
        case 'ArrayPattern':
          if (cur === null) {
            cur = {
              name: collapse(this.src.nodeText(c)),
              type: null,
              optional: false,
              hasDefault: false,
              rest,
              ref: 'none',
            };
            params.push(cur);
            rest = false;
          }
          break;
        case 'Optional':
          if (cur) {
            cur.optional = true;
          }
          break;
        case 'TypeAnnotation':
          if (cur) {
            cur.type = this.typeText(c);
          }
          break;
        case 'Equals':
          if (cur) {
            cur.hasDefault = true;
          }
          break;
        default:
          break;
      }
    }
    return params;
  }

  /** The declared return type of a function-like node, or null. */
  private returnsOf(fn: SyntaxNode): TypeRef | null {
    const ann = childNamed(fn, 'TypeAnnotation', 'TypePredicate');
    return ann ? this.typeRefOf(ann) : null;
  }

  /** `: T` annotation text without the colon. */
  private typeText(annotation: SyntaxNode): string {
    return collapse(this.src.nodeText(annotation).replace(/^:\s*/, ''));
  }

  private typeRefOf(annotation: SyntaxNode): TypeRef {
    const typeNode = children(annotation).find((c) => c.name !== ':');
    return {
      text: this.typeText(annotation),
      fields: typeNode?.name === 'ObjectType' ? this.objectTypeFields(typeNode) : null,
    };
  }

  private typeRefOfNode(type: SyntaxNode): TypeRef {
    return {
      text: collapse(this.src.nodeText(type)),
      fields: type.name === 'ObjectType' ? this.objectTypeFields(type) : null,
    };
  }

  private objectTypeFields(obj: SyntaxNode): Field[] {
    const out: Field[] = [];
    let doc: string | null = null;
    for (const c of children(obj)) {
      if (c.name === 'BlockComment') {
        doc = docFromBlockComment(this.src.nodeText(c));
        continue;
      }
      if (!['PropertyType', 'MethodType', 'IndexSignature'].includes(c.name)) {
        continue;
      }
      const nameNode = childNamed(c, 'PropertyDefinition', 'String', 'Number');
      const raw = this.src.nodeText(c);
      const name = nameNode
        ? unquote(this.src.nodeText(nameNode))
        : collapse(raw.split(':')[0] ?? raw);
      const ann = childNamed(c, 'TypeAnnotation');
      let type: string | null = ann ? this.typeText(ann) : null;
      if (c.name === 'MethodType' && nameNode) {
        type = collapse(raw.slice(nameNode.to - c.from));
      }
      out.push({
        name,
        type,
        optional: childNamed(c, 'Optional') !== null,
        doc,
        line: this.src.lineAt(c.from),
      });
      doc = null;
    }
    return out;
  }

  /* ---- calls ------------------------------------------------------------- */

  private collectCalls(node: SyntaxNode, out: string[]): void {
    for (const c of children(node)) {
      if (c.name === 'CallExpression') {
        const callee = c.firstChild;
        if (callee) {
          const text = this.calleeText(callee);
          if (text) {
            out.push(text);
          }
        }
      } else if (c.name === 'NewExpression') {
        const target = children(c).find(
          (d) => d.name === 'VariableName' || d.name === 'MemberExpression',
        );
        if (target) {
          out.push(`new ${collapse(this.src.nodeText(target))}`);
        }
      }
      this.collectCalls(c, out);
    }
  }

  private calleeText(callee: SyntaxNode): string | null {
    const text = collapse(this.src.nodeText(callee)).replace(/\?\./g, '.');
    if (callee.name === 'VariableName' || callee.name === 'super') {
      return text;
    }
    if (callee.name === 'MemberExpression') {
      if (/^[\w$]+(\.[\w$#]+)+$/.test(text)) {
        return text;
      }
      const prop = childNamed(callee, 'PropertyName', 'PrivatePropertyName');
      return prop ? `.${this.src.nodeText(prop)}` : null;
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
      if (s.name === 'BlockComment' || s.name === 'LineComment') {
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
      } else {
        seq = null;
        out.push(...nodes);
      }
    }
    return out;
  }

  /** A statement's first line, without `const`/`let` and the semicolon. */
  private stmtText(s: SyntaxNode): string {
    return cut(
      this.src
        .nodeText(s)
        .replace(/^(const|let|var)\s+/, '')
        .replace(/;\s*$/, ''),
    );
  }

  /** Flow nodes for a statement, or null when it is straight-line. */
  private stmtFlow(s: SyntaxNode): FlowNode[] | null {
    const line = this.src.lineAt(s.from);
    switch (s.name) {
      case 'IfStatement': {
        const cond = childNamed(s, 'ParenthesizedExpression');
        const consequent = cond ? nodeAfter(s, cond) : null;
        const elseKw = childNamed(s, 'else');
        const alternate = elseKw ? nodeAfter(s, elseKw) : null;
        return [
          {
            kind: 'if',
            line,
            cond: cond ? cut(stripParens(this.src.nodeText(cond))) : '',
            then: consequent ? this.flowOfBranch(consequent) : [],
            else: alternate ? this.flowOfBranch(alternate) : null,
          },
        ];
      }
      case 'ForStatement':
      case 'WhileStatement': {
        const body = lastStatementChild(s);
        const header = cut(this.src.slice(s.from, body ? body.from : s.to));
        return [{ kind: 'loop', line, header, body: body ? this.flowOfBranch(body) : [] }];
      }
      case 'DoStatement': {
        const body = childNamed(s, 'Block') ?? nodeAfter(s, s.firstChild!);
        const whileKw = childNamed(s, 'while');
        const tail = whileKw ? collapse(this.src.slice(whileKw.from, s.to)).replace(/;$/, '') : '';
        return [
          {
            kind: 'loop',
            line,
            header: cut(`do … ${tail}`),
            body: body ? this.flowOfBranch(body) : [],
          },
        ];
      }
      case 'SwitchStatement': {
        const subject = childNamed(s, 'ParenthesizedExpression');
        const body = childNamed(s, 'SwitchBody');
        const arms: FlowArm[] = [];
        let pending: { label: string; stmts: SyntaxNode[] } | null = null;
        const flush = () => {
          if (pending) {
            arms.push({ label: pending.label, body: this.flowOfStmts(pending.stmts) });
          }
        };
        for (const c of body ? children(body) : []) {
          if (c.name === 'CaseLabel') {
            flush();
            const label = cut(
              this.src
                .nodeText(c)
                .replace(/^case\s+/, '')
                .replace(/:$/, ''),
            );
            pending = { label, stmts: [] };
          } else if (c.name === 'DefaultLabel') {
            flush();
            pending = { label: 'default', stmts: [] };
          } else if (!PUNCT.includes(c.name) && pending) {
            pending.stmts.push(c);
          }
        }
        flush();
        return [
          {
            kind: 'switch',
            line,
            subject: subject ? cut(stripParens(this.src.nodeText(subject))) : '',
            arms,
          },
        ];
      }
      case 'TryStatement': {
        const block = childNamed(s, 'Block');
        const handlers: FlowArm[] = [];
        for (const c of children(s)) {
          if (c.name === 'CatchClause' || c.name === 'FinallyClause') {
            const inner = childNamed(c, 'Block');
            const label =
              c.name === 'FinallyClause'
                ? 'finally'
                : cut(this.src.slice(c.from, inner ? inner.from : c.to));
            handlers.push({ label, body: inner ? this.flowOfBlock(inner) : [] });
          }
        }
        return [{ kind: 'try', line, body: block ? this.flowOfBlock(block) : [], handlers }];
      }
      case 'ReturnStatement':
      case 'ThrowStatement':
      case 'BreakStatement':
      case 'ContinueStatement': {
        const text = cut(
          this.src
            .nodeText(s)
            .replace(/^(return|throw|break|continue)\b\s*/, '')
            .replace(/;\s*$/, ''),
        );
        return [{ kind: EXIT_KIND[s.name]!, line, text, conditional: false }];
      }
      case 'Block':
        return this.flowOfBlock(s);
      case 'LabeledStatement': {
        const inner = lastStatementChild(s);
        return inner ? (this.stmtFlow(inner) ?? [this.seqOf(inner)]) : null;
      }
      case 'FunctionDeclaration': {
        const body = childNamed(s, 'Block');
        const name = this.nameOf(s, 'VariableDefinition') ?? 'function';
        return [{ kind: 'fn', line, name, body: body ? this.flowOfBlock(body) : [] }];
      }
      case 'VariableDeclaration': {
        // `const consider = (…) => { … }` is an inner function.
        const defs = children(s).filter((c) => c.name === 'VariableDefinition');
        const fn = children(s).find((c) => FUNCTION_VALUES.includes(c.name));
        const body = fn ? childNamed(fn, 'Block') : null;
        if (defs.length === 1 && fn && body) {
          return [
            { kind: 'fn', line, name: this.src.nodeText(defs[0]!), body: this.flowOfBlock(body) },
          ];
        }
        return null;
      }
      default:
        return null;
    }
  }

  private seqOf(s: SyntaxNode): FlowNode {
    const line = this.src.lineAt(s.from);
    return { kind: 'seq', lines: [line, this.src.endLineOf(s)], items: [this.stmtText(s)] };
  }

  /** A branch body: a block's statements, or the single statement itself. */
  private flowOfBranch(node: SyntaxNode): FlowNode[] {
    return node.name === 'Block' ? this.flowOfBlock(node) : this.flowOfStmts([node]);
  }

  /* ---- x-ray depths ------------------------------------------------------ */

  /**
   * A declaration at depth `d`: its header lines (through the opening brace)
   * and closing brace stay at `d`; the body is painted one level down.
   */
  private paintDecl(node: SyntaxNode, d: number, p: SkeletonPainter): void {
    const first = this.src.lineAt(node.from);
    const last = this.src.endLineOf(node);
    const body = this.bodyOf(node);
    if (!body) {
      p.range(first, last, d);
      return;
    }
    p.range(first, this.src.lineAt(body.from), d);
    p.line(this.src.endLineOf(body), d);
    if (body.name === 'Block') {
      this.paintBlock(body, d + 1, p);
    } else if (body.name === 'ClassBody') {
      this.paintClassBody(body, d + 1, p);
    } else {
      // ObjectType / EnumBody / an arrow's expression body: members are
      // declarations and stay one level down, nothing deeper.
      p.range(this.src.lineAt(body.from) + 1, this.src.endLineOf(body) - 1, d + 1);
    }
  }

  /** The brace-delimited body of a declaration, looking through `export`. */
  private bodyOf(node: SyntaxNode): SyntaxNode | null {
    const decl =
      node.name === 'ExportDeclaration' || node.name === 'AmbientDeclaration'
        ? (childNamed(node, ...DECLARATIONS) ?? node)
        : node;
    const direct = childNamed(decl, 'Block', 'ClassBody', 'ObjectType', 'EnumBody');
    if (direct) {
      return direct;
    }
    if (decl.name === 'VariableDeclaration' || decl.name === 'TypeAliasDeclaration') {
      const equals = childNamed(decl, 'Equals');
      const value = equals ? nodeAfter(decl, equals) : null;
      if (value && FUNCTION_VALUES.includes(value.name)) {
        return childNamed(value, 'Block') ?? null;
      }
      if (value && value.name === 'ObjectType') {
        return value;
      }
    }
    return null;
  }

  private paintClassBody(body: SyntaxNode, d: number, p: SkeletonPainter): void {
    p.range(this.src.lineAt(body.from) + 1, this.src.endLineOf(body) - 1, d + 1);
    for (const m of children(body)) {
      if (m.name === 'MethodDeclaration') {
        this.paintDecl(m, d, p);
      } else if (m.name === 'PropertyDeclaration' || m.name === 'BlockComment') {
        p.range(this.src.lineAt(m.from), this.src.endLineOf(m), d);
      }
    }
  }

  /** Statements directly in a block are at depth `d`. */
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
    if (EXITS.includes(s.name)) {
      p.range(first, last, d);
    } else if (CONTROL.includes(s.name)) {
      this.paintControl(s, d, p);
    } else if (s.name === 'FunctionDeclaration' || s.name === 'ClassDeclaration') {
      this.paintDecl(s, d, p);
    } else if (s.name === 'VariableDeclaration' && this.bodyOf(s)) {
      this.paintDecl(s, d, p);
    } else {
      p.range(first, last, d + 1);
    }
  }

  private paintControl(s: SyntaxNode, d: number, p: SkeletonPainter): void {
    const first = this.src.lineAt(s.from);
    const last = this.src.endLineOf(s);
    p.range(first, last, d + 1);
    if (s.name === 'LabeledStatement') {
      const inner = lastStatementChild(s);
      if (inner) {
        this.paintStmt(inner, d, p);
      }
      return;
    }
    if (s.name === 'Block') {
      p.line(first, d);
      p.line(last, d);
      this.paintBlock(s, d + 1, p);
      return;
    }
    // Header: everything up to the first nested statement/block.
    const parts = children(s);
    const firstBody = parts.find(
      (c) => c.name === 'Block' || c.name === 'SwitchBody' || isStatement(c),
    );
    p.range(first, firstBody ? this.src.lineAt(firstBody.from) : last, d);
    for (const c of parts) {
      if (c.name === 'Block') {
        this.paintBlockBraces(c, d, p);
      } else if (c.name === 'SwitchBody') {
        this.paintBlockBraces(c, d, p);
        for (const item of children(c)) {
          if (item.name === 'CaseLabel' || item.name === 'DefaultLabel') {
            p.range(this.src.lineAt(item.from), this.src.endLineOf(item), d + 1);
          } else if (!PUNCT.includes(item.name)) {
            this.paintStmt(item, d + 1, p);
          }
        }
      } else if (c.name === 'CatchClause' || c.name === 'FinallyClause') {
        const inner = childNamed(c, 'Block');
        p.range(
          this.src.lineAt(c.from),
          inner ? this.src.lineAt(inner.from) : this.src.endLineOf(c),
          d,
        );
        if (inner) {
          this.paintBlockBraces(inner, d, p);
        }
      } else if (c.name === 'IfStatement') {
        // `else if` continues the chain at the same depth.
        this.paintControl(c, d, p);
      } else if (isStatement(c)) {
        this.paintStmt(c, d + 1, p);
      }
    }
  }

  private paintBlockBraces(block: SyntaxNode, d: number, p: SkeletonPainter): void {
    p.line(this.src.lineAt(block.from), d);
    p.line(this.src.endLineOf(block), d);
    this.paintBlock(block, d + 1, p);
  }
}

/* ---- small tree helpers ---------------------------------------------------- */

function qualify(parent: string | null, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function unquote(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function stripParens(s: string): string {
  const one = collapse(s);
  return one.startsWith('(') && one.endsWith(')') ? one.slice(1, -1).trim() : one;
}

/** The sibling right after `child` (its parent is passed for readability). */
function nodeAfter(_parent: SyntaxNode, child: SyntaxNode): SyntaxNode | null {
  return child.nextSibling;
}

const STATEMENT_NAMES = new Set([
  ...CONTROL,
  ...EXITS,
  'ExpressionStatement',
  'VariableDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'DebuggerStatement',
  'WithStatement',
  'EmptyStatement',
]);

function isStatement(node: SyntaxNode): boolean {
  return STATEMENT_NAMES.has(node.name);
}

/** The last child that is a statement (a loop/if body). */
function lastStatementChild(node: SyntaxNode): SyntaxNode | null {
  const stmts = children(node).filter(isStatement);
  return stmts[stmts.length - 1] ?? null;
}
