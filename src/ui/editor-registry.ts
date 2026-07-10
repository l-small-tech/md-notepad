/**
 * A tiny registry mapping tabId → its live CM6 source adapter.
 *
 * The ribbon (a single, tab-agnostic bar) needs to drive formatting on
 * whichever tab is active, but each source editor is created deep inside its
 * own EditorHost effect. Rather than thread refs up through React, EditorHost
 * registers its adapter here when the source factory runs and unregisters on
 * dispose; the ribbon looks up the active tab's adapter on demand.
 *
 * Only the CM6 source editor (raw/split modes) is tracked — the WYSIWYG editor
 * carries its own inline toolbar, and the ribbon reports a notice there.
 */

import type { Cm6Adapter } from '../editors/cm6';

const sourceAdapters = new Map<string, Cm6Adapter>();

export function registerSourceAdapter(tabId: string, adapter: Cm6Adapter): void {
  sourceAdapters.set(tabId, adapter);
}

export function unregisterSourceAdapter(tabId: string): void {
  sourceAdapters.delete(tabId);
}

export function getSourceAdapter(tabId: string): Cm6Adapter | undefined {
  return sourceAdapters.get(tabId);
}
