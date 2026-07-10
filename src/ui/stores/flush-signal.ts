/**
 * A one-function indirection so the tabs store can ask for a session flush
 * without importing the session controller (which imports the tabs store —
 * that would be a cycle). The controller registers the real flusher's
 * `request` at boot via {@link setFlushRequester}; until then `requestFlush`
 * is a no-op, which is exactly what unit tests want (they exercise the store
 * with no persistence attached).
 *
 * The store calls `requestFlush()` on every genuinely user-driven change
 * (typing, tab create/close/reorder/rename, mode/active-tab change). It must
 * NOT be called from post-flush bookkeeping (`applyFlushResult`,
 * `restoreSession`) — doing so would make every flush schedule another flush
 * and churn the manifest to disk once a second forever.
 */

let requester: () => void = () => {};

export function setFlushRequester(fn: () => void): void {
  requester = fn;
}

export function requestFlush(): void {
  requester();
}
