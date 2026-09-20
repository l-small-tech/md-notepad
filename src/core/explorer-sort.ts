/**
 * The order rows appear in the file drawer: folders first, then files, each
 * group A→Z by name with digit runs compared as numbers (`note2.md` before
 * `note10.md`).
 *
 * The sort lives here rather than in a backend because the backends disagree:
 * the desktop `list_dir` returns its own order, and an Android SAF listing
 * comes back in whatever order the provider chose with `mtimeMs: 0` for every
 * entry. One pure comparator over the mapped entries gives every workspace the
 * same order on every platform.
 *
 * Case is ignored for the primary comparison so `Notes` and `notes` sit
 * together; ties fall back to a plain code-unit compare, which keeps the sort
 * deterministic (two names differing only in case always land the same way
 * round).
 */

/** The shape the drawer sorts — `ExplorerEntry` and anything like it. */
export interface SortableEntry {
  name: string;
  isDir: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A→Z with numeric runs, ties broken so equal-ignoring-case names still order. */
export function compareEntryNames(a: string, b: string): number {
  const primary = collator.compare(a, b);
  if (primary !== 0) {
    return primary;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A copy of `entries`: directories first, then files, each `compareEntryNames`. */
export function sortExplorerEntries<T extends SortableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return compareEntryNames(a.name, b.name);
  });
}
