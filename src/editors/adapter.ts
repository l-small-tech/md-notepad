/**
 * The editor contract is DEFINED in src/core/mode-sync.ts (core is the
 * bottom layer and cannot import from here; implementations live here and
 * import from core). This re-export exists so editor code reads naturally:
 *
 *   import type { EditorAdapter } from './adapter';
 *
 * Implementations to build (recipes + pitfalls in ./README.md):
 * - cm6.ts      (M1) — CodeMirror 6 source editor, used by 'raw' and 'split'
 * - milkdown.ts (M5) — Crepe/Milkdown WYSIWYG behind a lazy import
 *
 * Contract reminders (enforced by core/mode-sync and its tests):
 * - attach(host, model) may be async; must render model.getText().
 * - detach() must SYNCHRONOUSLY flush pending write-back, then tear down.
 * - Adapters must survive attach → detach → attach (failed switches
 *   re-attach the previous editor).
 * - Echo suppression uses a reentrancy flag around pushText — subscription
 *   dispatch is synchronous, so version bookkeeping after the call is too
 *   late. See the pattern in src/core/doc-model.ts's header comment.
 */

export type { AdapterFactory, EditorAdapter } from '../core/mode-sync';
