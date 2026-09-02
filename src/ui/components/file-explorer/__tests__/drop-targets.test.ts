/**
 * @vitest-environment jsdom
 *
 * The drawer's drop-target CONTRACT: which directory a point in the explorer
 * resolves to (`dropDirAt`), and which md file takes an image embed
 * (`dropFileAt`). Both the internal pointer drag (useFileDrag) and the OS-drop
 * path in main.tsx hit-test these attributes, so the markup shape below mirrors
 * FileExplorer's render: a `.workspace-section` carrying the workspace root,
 * folder rows carrying themselves, file rows carrying their containing dir, and
 * a read-only workspace carrying nothing at all.
 *
 * The headline case: a target inside ANOTHER workspace resolves exactly like
 * one inside the dragged file's own — nothing here knows where a drag started.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// helpers.ts imports listNoteFiles from the session controller, whose module
// graph reaches Tauri plugins and the store singletons — none of which this
// suite touches. Stub it so importing the helpers stays side-effect free.
vi.mock('../../../session', () => ({
  listNoteFiles: vi.fn(() => Promise.resolve([])),
}));

import { dropDirAt, dropFileAt } from '../helpers';

/** Two writable workspaces plus a read-only one, in render order. */
function renderExplorer(): void {
  document.body.innerHTML = `
    <div class="file-explorer-list">
      <div class="workspace-section" data-drop-dir="/notes" id="ws-a">
        <div class="workspace-header">
          <button class="workspace-toggle" id="a-header"><span id="a-name">Notes</span></button>
        </div>
        <button class="file-explorer-dir" data-drop-dir="/notes/sub" id="a-folder">sub</button>
        <button class="file-explorer-item" data-drop-dir="/notes" data-drop-file="/notes/doc.md"
                id="a-file">doc.md</button>
      </div>
      <div class="workspace-section" data-drop-dir="/ws-b" id="ws-b">
        <div class="workspace-header">
          <button class="workspace-toggle" id="b-header"><span id="b-name">Project</span></button>
        </div>
        <button class="file-explorer-dir" data-drop-dir="/ws-b/inbox" id="b-folder">inbox</button>
        <button class="file-explorer-item" data-drop-dir="/ws-b" data-drop-file="/ws-b/notes.md"
                id="b-file">notes.md</button>
      </div>
      <div class="workspace-section" id="ws-docs">
        <div class="workspace-header">
          <button class="workspace-toggle" id="docs-header">Documentation</button>
        </div>
        <button class="file-explorer-item" id="docs-file">index.md</button>
      </div>
    </div>`;
}

const at = (id: string): Element => document.getElementById(id)!;

beforeEach(renderExplorer);

describe('dropDirAt', () => {
  test('a folder row in ANOTHER workspace is a valid target', () => {
    expect(dropDirAt(at('b-folder'))).toBe('/ws-b/inbox');
  });

  test("another workspace's header resolves to that workspace root", () => {
    // The whole section carries the root, so the label span inside the header
    // button resolves through `.closest` just as the button does.
    expect(dropDirAt(at('b-header'))).toBe('/ws-b');
    expect(dropDirAt(at('b-name'))).toBe('/ws-b');
  });

  test('a file row resolves to its containing directory, not to itself', () => {
    expect(dropDirAt(at('b-file'))).toBe('/ws-b');
    expect(dropDirAt(at('a-file'))).toBe('/notes');
  });

  test('rows in the source workspace resolve the same way — no origin is involved', () => {
    expect(dropDirAt(at('a-folder'))).toBe('/notes/sub');
    expect(dropDirAt(at('a-header'))).toBe('/notes');
  });

  test('a read-only workspace advertises nothing and refuses every drop', () => {
    expect(dropDirAt(at('docs-header'))).toBeNull();
    expect(dropDirAt(at('docs-file'))).toBeNull();
  });

  test('nothing under the pointer is not a target', () => {
    expect(dropDirAt(null)).toBeNull();
    expect(dropDirAt(document.body)).toBeNull();
  });
});

describe('dropFileAt', () => {
  test('an md row in another workspace accepts an image embed', () => {
    expect(dropFileAt(at('b-file'))).toBe('/ws-b/notes.md');
  });

  test('folder rows and headers are not embed targets', () => {
    expect(dropFileAt(at('b-folder'))).toBeNull();
    expect(dropFileAt(at('b-header'))).toBeNull();
  });

  test('a read-only file row is not an embed target', () => {
    expect(dropFileAt(at('docs-file'))).toBeNull();
  });
});
