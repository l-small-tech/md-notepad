/**
 * The Review pane for a code file (review_plan.md §5): a read-only, touch-first
 * projection of the parsed `CodeModel` — the header row (file name, Cards /
 * Calls views, a slot for the baseline picker), the filter chips, the imports
 * summary card, and one card per declaration with its plain-English sentence,
 * raw signature, rendered doc comment, a form for its fields, the facts row
 * (calls · used by) and the Code / Flow expanders. The Calls view draws the
 * in-file call graph.
 *
 * What changed (§6) is pushed in by the host: `setGitInfo` fills the header's
 * baseline slot (a picker, or "Git not found"), `setChanges` brings the change
 * map — added / changed badges with the signature note, ghost cards for
 * removed units, the Changed chip's count, the amber ring in the Calls view
 * and the worktree radar ("also changed on: feat/x"). The Changes view is the
 * deck under the Changed filter. The picker reports a `baseline` action; the
 * host (`ui/code-review-git.ts`) turns the baseline into a revision.
 *
 * Same shape as `pane.ts` (attach once, dispose once; `setDark`,
 * `setLineHold`), plus `setState` — the pane is DRIVEN by a `ReviewState`
 * (`core/code/review-state.ts`) and reports every tap as a `ReviewAction`
 * through `onAction`; the UI layer keeps the state in a store. Without
 * `onAction` the pane reduces the state itself, so it also works standalone.
 *
 * Layering (I9): core + `./mermaid` + `./pipeline` only. Highlighting reuses
 * the Lezer grammars the model is parsed with; the tag → class table mirrors
 * `editors/code-highlight.ts` (which this file must not import) and
 * `styles/code-review.css` maps the classes onto the same `--md-*` variables.
 */

import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { parser as jsParser } from '@lezer/javascript';
import { parser as rustParser } from '@lezer/rust';
import { flattenUnits, resolveCalls, type CallEdge } from '../core/code/calls';
import type { ChangeMap } from '../core/code/changes';
import { flowGraph, flowHasBranches } from '../core/code/flow';
import { callGraphMermaid, flowMermaid, kindGlyph, lineCount } from '../core/code/mermaid-text';
import { xrayLines, type CodeModel, type CodeUnit, type Field } from '../core/code/model';
import { codeLanguageFor, parseCode } from '../core/code/parse';
import { describeType, describeUnit } from '../core/code/plain-english';
import {
  DEFAULT_REVIEW_STATE,
  reduceReview,
  XRAY_FULL,
  xrayOpenedMap,
  type ReviewAction,
  type ReviewBaseline,
  type ReviewExpander,
  type ReviewFilter,
  type ReviewState,
  type ReviewView,
} from '../core/code/review-state';
import type { DocModel } from '../core/doc-model';
import { renderMermaidBlocks } from './mermaid';
import { createRenderSequence, renderMarkdownToHtml } from './pipeline';

const RENDER_DEBOUNCE_MS = 200;
/** Hold duration before `onHoldUnit` fires, and the drift that cancels it. */
const HOLD_MS = 500;
const HOLD_SLOP_PX = 10;
/** Units shorter than this skip the x-ray and open straight to full code. */
export const XRAY_MIN_LINES = 12;
/** Above this many lines the deck is an exported-only outline. */
export const LARGE_FILE_LINES = 5000;

export interface CodeReviewPaneOptions {
  dark: boolean;
  /** The file's path: its name heads the pane, its extension picks the language. */
  path: string;
  /** Initial state; `DEFAULT_REVIEW_STATE` when omitted. */
  state?: ReviewState;
  /**
   * Every tap that changes what the pane shows (a view, a chip, an expander,
   * an x-ray fold). The host reduces it into its store and calls `setState`.
   * Omit and the pane keeps the state itself.
   */
  onAction?: (action: ReviewAction) => void;
  /** A tap on a diagram's background — same contract as `pane.ts`. */
  onOpenDiagram?: (svgMarkup: string) => void;
  /**
   * The reader pressed and held on a card (the voice-note gesture). Only fires
   * while `setLineHold(true)` is in effect. `model` is the parse the card came
   * from, for the identifier vocabulary.
   */
  onHoldUnit?: (unit: CodeUnit, model: CodeModel) => void;
  /**
   * The pane re-parsed the document (first render, and after each 200 ms
   * debounce on a text change). The What-changed host recomputes its change
   * map from here; `model` is null for a file Review cannot read.
   */
  onModelChange?: (model: CodeModel | null, text: string) => void;
}

/** What the host knows about git for this file (review_plan.md §6). */
export interface ReviewGitInfo {
  /** False hides the baseline picker and shows `hint` in its place. */
  available: boolean;
  /** "Git not found" / "Not a git repository" — shown when unavailable. */
  hint?: string;
  /** The checked-out branch (null on a detached HEAD). */
  branch?: string | null;
  /** The branch "This branch" compares against. */
  baseBranch?: string | null;
  /** The merge-base "This branch" compares against; without it that option is hidden. */
  baseRef?: string | null;
}

/** A branch of another worktree whose copy of the file differs from the baseline. */
export interface RadarEntry {
  branch: string;
}

export interface CodeReviewPane {
  /** Mermaid bakes colours in — a theme flip re-renders the diagrams. */
  setDark(dark: boolean): void;
  /** The store's state for this tab changed; re-render what differs. */
  setState(state: ReviewState): void;
  /**
   * The What-changed result for the current baseline: badges, ghost cards, the
   * Changed chip's count and the worktree radar. `null` clears them (no git,
   * or the baseline is still loading). Never blocks: cards render first, and
   * this re-renders them with badges when it lands.
   */
  setChanges(changes: ChangeMap | null, radar: readonly RadarEntry[] | null): void;
  /** Fill the header's baseline slot: the picker, or the "no git" hint. */
  setGitInfo(info: ReviewGitInfo | null): void;
  /** Arm/disarm the press-and-hold card gesture (`onHoldUnit`). */
  setLineHold(on: boolean): void;
  /** Bring a unit's card into view (switching to the Cards view first). */
  scrollToUnit(unitId: string): void;
  /** The parse the pane currently shows (null before the first render / for a non-code file). */
  currentModel(): CodeModel | null;
  dispose(): void;
}

/* ---- highlighting ---------------------------------------------------------- */

/** Mirrors `editors/code-highlight.ts` — same tags, classes instead of colours. */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'cr-tok-keyword' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'cr-tok-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'cr-tok-literal' },
  { tag: tags.comment, class: 'cr-tok-comment' },
  { tag: [tags.typeName, tags.className, tags.namespace], class: 'cr-tok-type' },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.definition(tags.variableName)),
      tags.function(tags.propertyName),
      tags.definition(tags.variableName),
      tags.definition(tags.propertyName),
    ],
    class: 'cr-tok-def',
  },
  { tag: [tags.meta, tags.annotation, tags.operator, tags.macroName], class: 'cr-tok-meta' },
]);

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Every line of `text` as syntax-highlighted HTML. One parse of the whole
 * file (a method highlighted on its own would lose its class context); a
 * token that spans lines is closed and reopened at each newline.
 */
export function highlightLines(text: string, path: string): string[] {
  const lang = codeLanguageFor(path);
  const ext = (path.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  const parser =
    lang === 'rust'
      ? rustParser
      : jsParser.configure({
          dialect: [
            ext.startsWith('ts') || ext === 'mts' || ext === 'cts' ? 'ts' : '',
            ext.endsWith('sx') ? 'jsx' : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
  const tree = parser.parse(text);
  const lines: string[] = [];
  let current = '';
  const push = (from: number, to: number, cls: string | null): void => {
    const parts = text.slice(from, to).split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push(current);
        current = '';
      }
      if (part.length > 0) {
        current += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
      }
    });
  };
  let pos = 0;
  highlightTree(tree, highlighter, (from, to, classes) => {
    if (from > pos) {
      push(pos, from, null);
    }
    push(from, to, classes);
    pos = to;
  });
  if (pos < text.length) {
    push(pos, text.length, null);
  }
  lines.push(current);
  return lines;
}

/* ---- small renderers --------------------------------------------------------- */

/** The sentence's two markdown forms — `*field*` and `` `Type` `` — as HTML. */
function sentenceHtml(sentence: string): string {
  return esc(sentence)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Quartile thresholds of unit sizes → 1–4 dots per unit. */
function sizeDots(units: readonly CodeUnit[]): (unit: CodeUnit) => number {
  const sizes = units.map(lineCount).sort((a, b) => a - b);
  if (sizes.length === 0) {
    return () => 1;
  }
  const q = (p: number) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))]!;
  const thresholds = [q(0.25), q(0.5), q(0.75)];
  return (unit) => 1 + thresholds.filter((t) => lineCount(unit) > t).length;
}

const TYPE_KINDS = new Set(['interface', 'type', 'struct', 'enum', 'class', 'trait']);
const FUNCTION_KINDS = new Set(['function', 'method']);

/** `changed` is the set of unit ids the change map badges anything but `same`. */
function matchesFilter(
  unit: CodeUnit,
  filter: ReviewFilter,
  changed: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'exported':
      return unit.exported;
    case 'functions':
      return FUNCTION_KINDS.has(unit.kind);
    case 'types':
      return TYPE_KINDS.has(unit.kind);
    case 'changed':
      return changed.has(unit.id);
  }
}

const BASELINES: { id: ReviewBaseline; label: string }[] = [
  { id: 'branch', label: 'this branch' },
  { id: 'uncommitted', label: 'uncommitted' },
  { id: 'last-commit', label: 'last commit' },
];

const FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'exported', label: 'Exported' },
  { id: 'changed', label: 'Changed' },
  { id: 'functions', label: 'Functions' },
  { id: 'types', label: 'Types' },
];

const VIEWS: { id: ReviewView; label: string }[] = [
  { id: 'cards', label: 'Cards' },
  { id: 'calls', label: 'Calls' },
  { id: 'changes', label: 'Changes' },
];

function joinNames(names: string[], max = 6): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, +${rest} more` : '');
}

/* ---- the pane ------------------------------------------------------------------ */

export function attachCodeReviewPane(
  host: HTMLElement,
  docModel: DocModel,
  options: CodeReviewPaneOptions,
): CodeReviewPane {
  let dark = options.dark;
  let state: ReviewState = options.state ?? DEFAULT_REVIEW_STATE;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sequence = createRenderSequence();

  // Per-render derived data (rebuilt on every parse).
  let model: CodeModel | null = null;
  let unitsById = new Map<string, CodeUnit>();
  let edges: CallEdge[] = [];
  let dots: (unit: CodeUnit) => number = () => 1;
  let sourceLines: string[] = [];
  let highlighted: string[] | null = null; // lazy: only when a Code expander opens
  let highlightedFor = '';
  // Doc comment markdown → HTML, kept across renders (typing re-renders).
  const docCache = new Map<string, string>();
  // Mermaid node id → unit id for the Calls view's click handlers.
  let callNodes: { id: string; unitId: string }[] = [];
  // A card to scroll to once the next Cards render lands.
  let pendingScroll: string | null = null;
  // What-changed inputs, pushed by the host (null until git answers).
  let changes: ChangeMap | null = null;
  let changedIds = new Set<string>();
  let radar: string[] = [];
  let gitInfo: ReviewGitInfo | null = null;
  // The text `onModelChange` last reported, so theme/state renders stay quiet.
  let notifiedText: string | null = null;

  host.classList.add('cr-host');

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function apply(action: ReviewAction): void {
    if (options.onAction) {
      options.onAction(action);
    } else {
      setState(reduceReview(state, action));
    }
  }

  function parse(): void {
    const text = docModel.getText();
    model = parseCode(text, options.path);
    sourceLines = text.split('\n');
    if (highlightedFor !== text) {
      highlighted = null;
    }
    unitsById = new Map();
    edges = [];
    if (model) {
      const all = flattenUnits(model);
      for (const u of all) {
        unitsById.set(u.id, u);
      }
      edges = resolveCalls(model).edges;
      dots = sizeDots(all);
    }
    if (options.onModelChange && notifiedText !== text) {
      notifiedText = text;
      options.onModelChange(model, text);
    }
  }

  /** The filter the deck applies: the Changes view forces `changed`. */
  function activeFilter(): ReviewFilter {
    return state.view === 'changes' ? 'changed' : state.filter;
  }

  function unitStatus(unit: CodeUnit) {
    return changes?.units.get(unit.id) ?? null;
  }

  function codeLines(): string[] {
    const text = docModel.getText();
    if (!highlighted || highlightedFor !== text) {
      highlighted = highlightLines(text, options.path);
      highlightedFor = text;
    }
    return highlighted;
  }

  function resolveFields(name: string): Field[] | null {
    if (!model) {
      return null;
    }
    for (const u of unitsById.values()) {
      if (u.name === name && u.fields.length > 0) {
        return u.fields;
      }
    }
    return null;
  }

  async function docHtml(doc: string | null): Promise<string> {
    if (!doc) {
      return '';
    }
    let html = docCache.get(doc);
    if (html === undefined) {
      html = await renderMarkdownToHtml(doc);
      docCache.set(doc, html);
    }
    return html;
  }

  /* ---- header / chips ---- */

  /** Why Changes / Changed are disabled right now, or null when they are live. */
  function changesDisabledReason(): string | null {
    if (changes !== null) {
      return null;
    }
    if (gitInfo && !gitInfo.available) {
      return gitInfo.hint ?? 'Git is not available';
    }
    return 'Waiting for git';
  }

  function headerHtml(): string {
    const reason = changesDisabledReason();
    const views = VIEWS.map((v) => {
      const disabled = v.id === 'changes' && reason !== null;
      return `<button type="button" class="cr-view${state.view === v.id ? ' cr-view-active' : ''}" data-view="${v.id}" aria-pressed="${state.view === v.id}"${disabled ? ` disabled title="${esc(reason ?? '')}"` : ''}>${v.label}</button>`;
    }).join('');
    return `<div class="cr-header"><span class="cr-file" title="${esc(options.path)}">${esc(baseName(options.path))}</span><div class="cr-views" role="group" aria-label="Review view">${views}</div><span class="cr-baseline-slot" id="cr-baseline-slot">${baselineSlotHtml()}</span></div>`;
  }

  /** The baseline picker (git present) or the one-line hint (git absent). */
  function baselineSlotHtml(): string {
    if (!gitInfo) {
      return '';
    }
    if (!gitInfo.available) {
      return `<span class="cr-git-hint">${esc(gitInfo.hint ?? 'Git is not available')}</span>`;
    }
    const options_ = BASELINES.filter((b) => b.id !== 'branch' || gitInfo?.baseRef).map((b) => {
      const label =
        b.id === 'branch' && gitInfo?.baseBranch
          ? `${b.label} (vs ${gitInfo.baseBranch})`
          : b.label;
      return `<option value="${b.id}"${state.baseline === b.id ? ' selected' : ''}>${esc(label)}</option>`;
    });
    const branch = gitInfo.branch ? ` title="on ${esc(gitInfo.branch)}"` : '';
    return `<label class="cr-baseline"${branch}><span class="cr-baseline-label">vs</span><select class="cr-baseline-select" aria-label="Compare against">${options_.join('')}</select></label>`;
  }

  function chipsHtml(): string {
    const reason = changesDisabledReason();
    const chips = FILTERS.map((f) => {
      const disabled = f.id === 'changed' && reason !== null;
      const label =
        f.id === 'changed' && changes !== null ? `${f.label} (${changes.changedCount})` : f.label;
      return `<button type="button" class="cr-chip${state.filter === f.id ? ' cr-chip-active' : ''}" data-filter="${f.id}" aria-pressed="${state.filter === f.id}"${disabled ? ` disabled title="${esc(reason ?? '')}"` : ''}>${label}</button>`;
    }).join('');
    return `<div class="cr-chips" role="group" aria-label="Filter cards">${chips}</div>`;
  }

  /* ---- cards ---- */

  function importsHtml(m: CodeModel): string {
    const internal = m.imports.find((g) => g.kind === 'internal')?.entries ?? [];
    const packages = m.imports.find((g) => g.kind === 'package')?.entries ?? [];
    const things = internal.reduce((n, e) => n + Math.max(1, e.names.length), 0);
    const parts: string[] = [];
    if (internal.length > 0) {
      const detail = internal
        .map((e) => `<code>${esc(e.source)}</code>: ${esc(joinNames(e.names))}`)
        .join('; ');
      parts.push(`${things} ${things === 1 ? 'thing' : 'things'} from this app (${detail})`);
    }
    if (packages.length > 0) {
      const names = [...new Set(packages.map((e) => e.source))];
      parts.push(
        `${names.length} ${names.length === 1 ? 'package' : 'packages'} (${esc(joinNames(names))})`,
      );
    }
    const text =
      parts.length > 0 ? `Uses ${parts.join(' and ')}.` : 'Uses nothing from outside this file.';
    return `<div class="cr-card cr-imports"><div class="cr-card-head cr-card-head-static"><span class="cr-glyph">▤</span><span class="cr-sentence">${text}</span></div></div>`;
  }

  function formHtml(unit: CodeUnit, m: CodeModel): string {
    if (unit.fields.length === 0) {
      return '';
    }
    const rows = unit.fields
      .map((f) => {
        const type = f.type ? sentenceHtml(describeType(f.type, m.language, resolveFields)) : '';
        return `<tr><td class="cr-form-name"><code>${esc(f.name)}${f.optional ? '?' : ''}</code></td><td class="cr-form-type">${type}</td><td class="cr-form-doc">${esc(f.doc ?? '')}</td></tr>`;
      })
      .join('');
    return `<table class="cr-form"><tbody>${rows}</tbody></table>`;
  }

  function factsHtml(unit: CodeUnit): string {
    const link = (id: string) => {
      const u = unitsById.get(id);
      return u
        ? `<button type="button" class="cr-fact-link" data-goto="${esc(id)}">${esc(u.name)}</button>`
        : '';
    };
    const calls = edges
      .filter((e) => e.from === unit.id && e.to !== unit.id)
      .map((e) => link(e.to));
    const usedBy = edges
      .filter((e) => e.to === unit.id && e.from !== unit.id)
      .map((e) => link(e.from));
    const parts: string[] = [];
    if (calls.length > 0) {
      parts.push(`calls ${calls.join(', ')}`);
    }
    if (usedBy.length > 0) {
      parts.push(`used by ${usedBy.join(', ')}`);
    }
    // The worktree radar: this card changed here AND the file changed on
    // another worktree's branch — the merge conflict, seen while reading.
    if (radar.length > 0 && changedIds.has(unit.id)) {
      parts.push(
        `<span class="cr-radar">also changed on: ${radar.map((b) => `<code>${esc(b)}</code>`).join(', ')}</span>`,
      );
    }
    return parts.length > 0 ? `<span class="cr-facts">${parts.join(' · ')}</span>` : '';
  }

  /** The added / changed badge for a card head (empty when same or unknown). */
  function badgesHtml(unit: CodeUnit): string {
    const info = unitStatus(unit);
    if (!info || info.status === 'same') {
      return '';
    }
    const label = info.status === 'added' ? 'added' : 'changed';
    const title = info.signatureNote ? ` title="${esc(info.signatureNote)}"` : '';
    return `<span class="cr-badge cr-badge-${label}"${title}>${label}</span>`;
  }

  /** "now also takes hiddenDirs" — under the signature of a signature-changed card. */
  function changeNoteHtml(unit: CodeUnit): string {
    const note = unitStatus(unit)?.signatureNote;
    return note ? `<p class="cr-change-note">${esc(note)}</p>` : '';
  }

  /** A unit the baseline had and the file no longer does. */
  function ghostHtml(unit: CodeUnit): string {
    const children =
      unit.children.length > 0
        ? `<p class="cr-note">Took with it: ${unit.children.map((c) => `<code>${esc(c.name)}</code>`).join(', ')}</p>`
        : '';
    return [
      `<article class="cr-card cr-card-ghost" data-ghost-id="${esc(unit.id)}" data-kind="${unit.kind}">`,
      `<div class="cr-card-head cr-card-head-static">`,
      `<span class="cr-glyph" aria-hidden="true">${kindGlyph(unit.kind)}</span>`,
      `<span class="cr-name">Removed: <code>${esc(unit.name)}</code></span>`,
      `<span class="cr-badges"><span class="cr-badge cr-badge-removed">removed</span></span>`,
      `<span class="cr-kind">${unit.kind}</span>`,
      `</div>`,
      `<div class="cr-card-body"><code class="cr-signature">${esc(unit.signature)}</code>${children}</div>`,
      `</article>`,
    ].join('');
  }

  function expanderPillsHtml(unit: CodeUnit): string {
    const open = state.expanded[unit.id];
    const pills: string[] = [];
    if (unit.skeleton.length > 0) {
      pills.push(
        `<button type="button" class="cr-pill${open === 'code' ? ' cr-pill-active' : ''}" data-expander="code" aria-pressed="${open === 'code'}">Code</button>`,
      );
    }
    if (flowHasBranches(unit.flow)) {
      pills.push(
        `<button type="button" class="cr-pill${open === 'flow' ? ' cr-pill-active' : ''}" data-expander="flow" aria-pressed="${open === 'flow'}">Flow</button>`,
      );
    }
    return pills.length > 0 ? `<span class="cr-expanders">${pills.join('')}</span>` : '';
  }

  function xrayHtml(unit: CodeUnit): string {
    const lines = codeLines();
    const short = lineCount(unit) < XRAY_MIN_LINES;
    const depth = short ? XRAY_FULL : (state.xrayDepth[unit.id] ?? 1);
    const rows = xrayLines(unit.skeleton, depth, xrayOpenedMap(state, unit.id));
    const body = rows
      .map((l) =>
        l.hiddenLines > 0
          ? `<button type="button" class="cr-xray-fold" data-fold-line="${l.line}" data-fold-depth="${l.depth}" title="Open one level">${esc(l.text)}</button>`
          : `<div class="cr-line" data-src-line="${l.line}">${lines[l.line - 1] ?? esc(sourceLines[l.line - 1] ?? '')}</div>`,
      )
      .join('');
    const all =
      !short && depth !== XRAY_FULL
        ? `<button type="button" class="cr-xray-all" data-xray-all="1">Show everything</button>`
        : '';
    return `<div class="cr-expander cr-code" data-expander-body="code"><pre class="cr-source">${body}</pre>${all}</div>`;
  }

  function flowHtml(unit: CodeUnit): string {
    const graph = flowGraph(unit);
    const note = graph.truncated
      ? `<p class="cr-note">Big function — showing the top level only (${graph.nodes.length} steps).</p>`
      : '';
    return `<div class="cr-expander cr-flow" data-expander-body="flow">${note}<pre><code class="language-mermaid">${esc(flowMermaid(graph))}</code></pre></div>`;
  }

  function expanderHtml(unit: CodeUnit): string {
    const open = state.expanded[unit.id];
    if (open === 'code') {
      return xrayHtml(unit);
    }
    if (open === 'flow') {
      return flowHtml(unit);
    }
    return '';
  }

  async function cardBodyHtml(unit: CodeUnit, m: CodeModel, compact: boolean): Promise<string> {
    const sentence = sentenceHtml(describeUnit(unit, { lang: m.language, resolve: resolveFields }));
    if (compact) {
      return `<p class="cr-sentence">${sentence}</p>`;
    }
    const doc = await docHtml(unit.doc);
    const docOpen = state.expanded[unit.id] === 'doc';
    return [
      `<p class="cr-sentence">${sentence}</p>`,
      `<code class="cr-signature">${esc(unit.signature)}</code>`,
      changeNoteHtml(unit),
      doc ? `<div class="cr-doc${docOpen ? ' cr-doc-open' : ''}">${doc}</div>` : '',
      formHtml(unit, m),
      `<div class="cr-row">${factsHtml(unit)}${expanderPillsHtml(unit)}</div>`,
      expanderHtml(unit),
    ].join('');
  }

  async function cardHtml(
    unit: CodeUnit,
    m: CodeModel,
    filter: ReviewFilter,
    compact: boolean,
    sub: boolean,
  ): Promise<string> {
    const body = await cardBodyHtml(unit, m, compact);
    const children = compact
      ? []
      : await Promise.all(
          unit.children
            .filter((c) => matchesFilter(c, filter, changedIds))
            .map((c) => cardHtml(c, m, filter, compact, true)),
        );
    const size = dots(unit);
    const dotsHtml = Array.from({ length: 4 }, (_, i) => (i < size ? '▪' : '▫')).join('');
    const status = unitStatus(unit)?.status;
    const statusAttr = status && status !== 'same' ? ` data-status="${status}"` : '';
    return [
      `<article class="cr-card${sub ? ' cr-card-sub' : ''}" data-unit-id="${esc(unit.id)}" data-line="${unit.signatureLine}" data-kind="${unit.kind}"${statusAttr}>`,
      `<button type="button" class="cr-card-head" aria-label="${esc(unit.name)}">`,
      `<span class="cr-glyph" aria-hidden="true">${kindGlyph(unit.kind)}</span>`,
      `<span class="cr-name">${esc(unit.name)}</span>`,
      `<span class="cr-badges" data-badges="${esc(unit.id)}">${badgesHtml(unit)}</span>`,
      unit.exported ? `<span class="cr-pill-tag cr-tag-exported">exported</span>` : '',
      `<span class="cr-kind">${unit.kind}</span>`,
      `<span class="cr-size" title="${lineCount(unit)} lines" aria-label="${lineCount(unit)} lines">${dotsHtml}</span>`,
      `</button>`,
      `<div class="cr-card-body">${body}</div>`,
      children.length > 0 ? `<div class="cr-children">${children.join('')}</div>` : '',
      `</article>`,
    ].join('');
  }

  async function deckHtml(m: CodeModel): Promise<string> {
    const large = sourceLines.length > LARGE_FILE_LINES;
    const filter = activeFilter();
    let units = m.units.filter(
      (u) =>
        (!large || u.exported) &&
        (matchesFilter(u, filter, changedIds) ||
          u.children.some((c) => matchesFilter(c, filter, changedIds))),
    );
    if (filter === 'changed') {
      // Changed cards float first; containers that only hold a changed method follow.
      const own = units.filter((u) => changedIds.has(u.id));
      units = [...own, ...units.filter((u) => !changedIds.has(u.id))];
    }
    const cards = await Promise.all(units.map((u) => cardHtml(u, m, filter, large, false)));
    // Ghost cards close the deck whenever the filter would show a removal.
    const ghosts =
      changes && (filter === 'all' || filter === 'changed')
        ? changes.removed.map((u) => ghostHtml(u))
        : [];
    const notes: string[] = [];
    if (large) {
      notes.push(
        `<p class="cr-note cr-note-large">Large file (${sourceLines.length.toLocaleString()} lines) — showing the exported outline only.</p>`,
      );
    }
    const empty =
      cards.length === 0 && ghosts.length === 0
        ? `<p class="cr-note cr-empty">${filter === 'changed' ? 'Nothing changed against this baseline.' : 'Nothing matches this filter.'}</p>`
        : '';
    return `${notes.join('')}${importsHtml(m)}<div class="cr-deck">${cards.join('')}${ghosts.join('')}${empty}</div>`;
  }

  function callsHtml(m: CodeModel): string {
    const graph = callGraphMermaid(m, {
      focus: state.showAll ? false : undefined,
      changed: changedIds,
    });
    callNodes = graph.nodes;
    const notes: string[] = [];
    if (graph.focused) {
      notes.push(
        `<p class="cr-note">Showing exported units and their neighbours (${graph.nodes.length} of ${graph.total}). <button type="button" class="cr-pill" data-show-all="1">Show all</button></p>`,
      );
    } else if (graph.omitted > 0) {
      notes.push(`<p class="cr-note">${graph.omitted} more units are not drawn.</p>`);
    }
    if (graph.nodes.length === 0) {
      notes.push(`<p class="cr-note cr-empty">No functions to draw.</p>`);
      return `<div class="cr-calls">${notes.join('')}</div>`;
    }
    return `<div class="cr-calls">${notes.join('')}<p class="cr-hint">Arrows read "uses". Tap a box to jump to its card; tap the background to zoom.</p><pre><code class="language-mermaid">${esc(graph.text)}</code></pre></div>`;
  }

  /* ---- render loop ---- */

  async function render(): Promise<void> {
    const token = sequence.start();
    parse();
    const m = model;
    let html: string;
    if (!m) {
      html = `<div class="cr-root">${headerHtml()}<p class="cr-note cr-empty">Review reads TypeScript, JavaScript and Rust files. This file only has a source view.</p></div>`;
    } else {
      const warn =
        m.parseErrors > 0
          ? `<p class="cr-note cr-warn">Some of this file did not parse cleanly (${m.parseErrors} ${m.parseErrors === 1 ? 'place' : 'places'}) — cards near the problem may be incomplete.</p>`
          : '';
      const body = state.view === 'calls' ? callsHtml(m) : await deckHtml(m);
      // The Changes view IS the deck under the Changed filter — no chip row.
      const chips = state.view === 'changes' ? '' : chipsHtml();
      html = `<div class="cr-root">${headerHtml()}${chips}${warn}<div class="cr-body" data-view="${state.view}">${body}</div></div>`;
    }
    if (disposed || !sequence.isCurrent(token)) {
      return;
    }
    const scrollTop = host.scrollTop;
    host.innerHTML = html;
    host.scrollTop = scrollTop;
    await renderMermaidBlocks(host, { dark });
    if (disposed || !sequence.isCurrent(token)) {
      return;
    }
    if (pendingScroll !== null && state.view === 'cards') {
      const id = pendingScroll;
      pendingScroll = null;
      scrollToUnit(id);
    }
  }

  function scheduleRender(): void {
    clearTimer();
    timer = setTimeout(() => void render(), RENDER_DEBOUNCE_MS);
  }

  /** Re-render one card's body in place (an expander or fold changed). */
  async function refreshCard(unitId: string): Promise<void> {
    const m = model;
    const unit = unitsById.get(unitId);
    const card = host.querySelector<HTMLElement>(`.cr-card[data-unit-id="${cssEscape(unitId)}"]`);
    const body = card?.querySelector<HTMLElement>(':scope > .cr-card-body');
    if (!m || !unit || !body) {
      return;
    }
    const html = await cardBodyHtml(unit, m, false);
    if (disposed || !body.isConnected) {
      return;
    }
    body.innerHTML = html;
    await renderMermaidBlocks(body, { dark });
  }

  function cssEscape(s: string): string {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  function scrollToUnit(unitId: string): void {
    if (disposed) {
      return;
    }
    if (state.view !== 'cards') {
      pendingScroll = unitId;
      apply({ type: 'view', view: 'cards' });
      return;
    }
    const card = host.querySelector<HTMLElement>(`.cr-card[data-unit-id="${cssEscape(unitId)}"]`);
    if (!card) {
      return;
    }
    card.scrollIntoView({ block: 'start', behavior: 'auto' });
    card.classList.add('cr-card-flash');
    setTimeout(() => card.classList.remove('cr-card-flash'), 1200);
  }

  function setState(next: ReviewState): void {
    if (disposed) {
      return;
    }
    const prev = state;
    state = next;
    if (prev === next) {
      return;
    }
    const structural =
      prev.view !== next.view ||
      prev.filter !== next.filter ||
      prev.showAll !== next.showAll ||
      prev.baseline !== next.baseline;
    if (structural || model === null) {
      clearTimer();
      void render();
      return;
    }
    const touched = new Set<string>();
    for (const id of new Set([...Object.keys(prev.expanded), ...Object.keys(next.expanded)])) {
      if (prev.expanded[id] !== next.expanded[id]) {
        touched.add(id);
      }
    }
    for (const id of new Set([...Object.keys(prev.xrayDepth), ...Object.keys(next.xrayDepth)])) {
      if (prev.xrayDepth[id] !== next.xrayDepth[id]) {
        touched.add(id);
      }
    }
    for (const id of new Set([...Object.keys(prev.xrayOpened), ...Object.keys(next.xrayOpened)])) {
      if (prev.xrayOpened[id] !== next.xrayOpened[id]) {
        touched.add(id);
      }
    }
    for (const id of touched) {
      void refreshCard(id);
    }
  }

  /* ---- events ---- */

  function onClick(event: MouseEvent): void {
    const el = event.target as HTMLElement;
    const view = el.closest<HTMLElement>('button[data-view]');
    if (view?.dataset.view && !(view as HTMLButtonElement).disabled) {
      apply({ type: 'view', view: view.dataset.view as ReviewView });
      return;
    }
    const chip = el.closest<HTMLElement>('[data-filter]');
    if (chip?.dataset.filter && !(chip as HTMLButtonElement).disabled) {
      apply({ type: 'filter', filter: chip.dataset.filter as ReviewFilter });
      return;
    }
    if (el.closest('[data-show-all]')) {
      apply({ type: 'show-all', showAll: true });
      return;
    }
    const goto = el.closest<HTMLElement>('[data-goto]');
    if (goto?.dataset.goto) {
      scrollToUnit(goto.dataset.goto);
      return;
    }
    const card = el.closest<HTMLElement>('.cr-card[data-unit-id]');
    const unitId = card?.dataset.unitId;
    if (card && unitId) {
      const pill = el.closest<HTMLElement>('[data-expander]');
      if (pill?.dataset.expander) {
        apply({
          type: 'toggle-expander',
          unitId,
          expander: pill.dataset.expander as ReviewExpander,
        });
        return;
      }
      const fold = el.closest<HTMLElement>('[data-fold-line]');
      if (fold) {
        apply({
          type: 'open-xray',
          unitId,
          line: Number(fold.dataset.foldLine),
          depth: Number(fold.dataset.foldDepth),
        });
        return;
      }
      if (el.closest('[data-xray-all]')) {
        apply({ type: 'xray-depth', unitId, depth: XRAY_FULL });
        return;
      }
      if (el.closest('.cr-card-head') && el.closest('.cr-card-head')?.parentElement === card) {
        apply({ type: 'toggle-expander', unitId, expander: 'doc' });
        return;
      }
    }
    const diagram = el.closest<HTMLElement>('.mermaid-diagram');
    if (diagram) {
      event.preventDefault();
      const node = el.closest<SVGElement>('g.node');
      if (node && diagram.closest('.cr-calls')) {
        const hit = callNodes.find((n) => node.id.startsWith(`flowchart-${n.id}-`));
        if (hit) {
          scrollToUnit(hit.unitId);
          return;
        }
      }
      options.onOpenDiagram?.(diagram.innerHTML);
    }
  }

  /* ---- press-and-hold card gesture (voice notes) ---- */
  let holdArmed = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdX = 0;
  let holdY = 0;
  let holdTarget: Element | null = null;

  function clearHold(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!holdArmed || !options.onHoldUnit) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    holdX = event.clientX;
    holdY = event.clientY;
    holdTarget = event.target instanceof Element ? event.target : null;
    clearHold();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (disposed || !model) {
        return;
      }
      const card = holdTarget?.closest<HTMLElement>('.cr-card[data-unit-id]');
      const unit = card?.dataset.unitId ? unitsById.get(card.dataset.unitId) : undefined;
      if (unit && host.contains(card!)) {
        options.onHoldUnit?.(unit, model);
      }
    }, HOLD_MS);
  }

  function onPointerMove(event: PointerEvent): void {
    if (
      holdTimer !== null &&
      (Math.abs(event.clientX - holdX) > HOLD_SLOP_PX ||
        Math.abs(event.clientY - holdY) > HOLD_SLOP_PX)
    ) {
      clearHold();
    }
  }

  function onContextMenu(event: MouseEvent): void {
    if (holdArmed) {
      event.preventDefault();
    }
  }

  /** The baseline picker: reported as a plain `baseline` action like every tap. */
  function onChange(event: Event): void {
    const select = event.target;
    if (select instanceof HTMLSelectElement && select.classList.contains('cr-baseline-select')) {
      const value = select.value as ReviewBaseline;
      if (BASELINES.some((b) => b.id === value)) {
        apply({ type: 'baseline', baseline: value });
      }
    }
  }

  /** Swap the header's baseline slot in place (no re-render of the deck). */
  function refreshBaselineSlot(): void {
    const slot = host.querySelector<HTMLElement>('#cr-baseline-slot');
    if (slot) {
      slot.innerHTML = baselineSlotHtml();
    }
  }

  function setChanges(next: ChangeMap | null, nextRadar: readonly RadarEntry[] | null): void {
    if (disposed) {
      return;
    }
    const wasNull = changes === null;
    changes = next;
    changedIds = new Set<string>();
    if (next) {
      for (const [id, info] of next.units) {
        if (info.status !== 'same') {
          changedIds.add(id);
        }
      }
    }
    radar = (nextRadar ?? []).map((r) => r.branch);
    if (wasNull && next === null) {
      return; // still nothing to badge — the deck is already right
    }
    clearTimer();
    void render();
  }

  function setGitInfo(next: ReviewGitInfo | null): void {
    if (disposed) {
      return;
    }
    gitInfo = next;
    // The slot is cheap to swap in place; the Changes/Changed enablement only
    // depends on `changes`, which arrives through setChanges and re-renders.
    // Unavailable git, though, changes their disabled hint — re-render then.
    if (next && !next.available) {
      clearTimer();
      void render();
    } else {
      refreshBaselineSlot();
    }
  }

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('pointerdown', onPointerDown);
  host.addEventListener('pointermove', onPointerMove);
  host.addEventListener('pointerup', clearHold);
  host.addEventListener('pointercancel', clearHold);
  host.addEventListener('pointerleave', clearHold);
  const unsubscribe = docModel.subscribe(scheduleRender);
  void render();

  return {
    setDark(next) {
      if (disposed || dark === next) {
        return;
      }
      dark = next;
      clearTimer();
      void render();
    },
    setState,
    setChanges,
    setGitInfo,
    setLineHold(on) {
      holdArmed = on;
      clearHold();
      if (on) {
        host.dataset.lineHold = '';
      } else {
        delete host.dataset.lineHold;
      }
    },
    scrollToUnit,
    currentModel: () => model,
    dispose() {
      disposed = true;
      clearTimer();
      clearHold();
      unsubscribe();
      host.classList.remove('cr-host');
      delete host.dataset.lineHold;
      host.removeEventListener('click', onClick);
      host.removeEventListener('change', onChange);
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', clearHold);
      host.removeEventListener('pointercancel', clearHold);
      host.removeEventListener('pointerleave', clearHold);
    },
  };
}
