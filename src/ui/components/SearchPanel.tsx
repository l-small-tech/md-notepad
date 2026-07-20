/**
 * SearchPanel (Ctrl/Cmd+Shift+F) — global workspace search over every
 * workspace root (see src/ui/stores/search.ts for the orchestration).
 *
 * Overlay pattern follows CommandPalette: mounted in App, rendered only while
 * `searchStore.open`, backdrop click closes, all keyboard handling lives on
 * the autofocused input and calls `stopPropagation()` so the global keydown
 * listener never sees panel keys. The inner body is a separate component so
 * its state mounts fresh each time the panel opens.
 *
 * Typing is debounced 300 ms before a run; queries under MIN_QUERY_LENGTH
 * show a hint instead of searching. Results are grouped by file; ArrowUp/Down
 * move a flat selection across groups, Enter/click opens the file and jumps
 * to the matched line via the session facade's `openNotePathAtLine`.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { baseName, dirName } from '../../core/session/plan-flush';
import type { SearchMatch } from '../../core/search';
import { isSafPath, SAF_PREFIX } from '../../ipc/provider';
import { openNotePathAtLine } from '../session';
import { MIN_QUERY_LENGTH, searchStore, useSearchStore } from '../stores/search';

const DEBOUNCE_MS = 300;

/**
 * Muted parent-path shown beside a file name. A `saf://` id's token segment is
 * an encoded tree URI (unreadable); show "synced folder" plus the rel dir.
 */
function displayDir(path: string): string {
  const dir = dirName(path);
  if (!isSafPath(dir)) {
    return dir;
  }
  const rest = dir.slice(SAF_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? 'synced folder' : `synced folder${rest.slice(slash)}`;
}

interface FileGroup {
  path: string;
  name: string;
  dir: string;
  /** Matches plus their index into the flat results array (selection space). */
  rows: { match: SearchMatch; flatIndex: number }[];
}

function groupByFile(results: SearchMatch[]): FileGroup[] {
  const groups: FileGroup[] = [];
  const byPath = new Map<string, FileGroup>();
  results.forEach((match, flatIndex) => {
    let group = byPath.get(match.path);
    if (!group) {
      group = {
        path: match.path,
        name: baseName(match.path),
        dir: displayDir(match.path),
        rows: [],
      };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.rows.push({ match, flatIndex });
  });
  return groups;
}

export function SearchPanel() {
  const open = useSearchStore((s) => s.open);
  if (!open) {
    return null;
  }
  return <SearchBody />;
}

function SearchBody() {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useSearchStore((s) => s.results);
  const searching = useSearchStore((s) => s.searching);
  const truncated = useSearchStore((s) => s.truncated);
  const error = useSearchStore((s) => s.error);

  const groups = useMemo(() => groupByFile(results), [results]);
  const tooShort = input.trim().length < MIN_QUERY_LENGTH;

  // Debounced run; leftover state from the previous open is cleared on mount.
  useEffect(() => {
    if (tooShort) {
      searchStore.getState().clear();
      return;
    }
    const timer = setTimeout(() => void searchStore.getState().run(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, tooShort]);

  // Typing can shrink the list under the selection — clamp instead of losing it.
  const sel = results.length === 0 ? 0 : Math.min(selected, results.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('.search-row.is-selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel, results]);

  const close = () => searchStore.getState().closeSearch();
  const jump = (match: SearchMatch) => {
    close();
    openNotePathAtLine(match.path, match.line);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // The panel owns its keys — never let the global shortcut listener or an
    // editor underneath react to them.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) {
        setSelected((sel + 1) % results.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) {
        setSelected((sel - 1 + results.length) % results.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const match = results[sel];
      if (match) {
        jump(match);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
      // mod+Shift+F toggles: pressing it again with the panel open closes it.
      e.preventDefault();
      close();
    }
  };

  return (
    <div
      className="palette-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        className="palette search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search in workspaces"
      >
        <input
          className="palette-input"
          type="text"
          placeholder="Search in all workspaces…"
          aria-label="Search in all workspaces"
          spellCheck={false}
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="search-results" ref={listRef} role="listbox" aria-label="Search results">
          {tooShort ? (
            <div className="search-hint">
              Type at least {MIN_QUERY_LENGTH} characters to search.
            </div>
          ) : results.length === 0 && !searching ? (
            <div className="search-hint">{error ?? 'No matches.'}</div>
          ) : (
            groups.map((group) => (
              <div key={group.path} className="search-group">
                <div className="search-file" title={group.path}>
                  <span className="search-file-name">{group.name}</span>
                  {group.dir && <span className="search-file-dir">{group.dir}</span>}
                </div>
                {group.rows.map(({ match, flatIndex }) => (
                  <div
                    key={`${flatIndex}`}
                    className={`search-row${flatIndex === sel ? ' is-selected' : ''}`}
                    role="option"
                    aria-selected={flatIndex === sel}
                    // Keep focus in the input so the keyboard keeps working.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => setSelected(flatIndex)}
                    onClick={() => jump(match)}
                  >
                    <span className="search-row-line">{match.line}</span>
                    <span className="search-row-text">{match.lineText}</span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="search-footer" aria-live="polite">
          {searching
            ? 'Searching…'
            : tooShort || error !== null
              ? ''
              : `${results.length} ${results.length === 1 ? 'match' : 'matches'}${truncated ? ' (truncated)' : ''}`}
        </div>
      </div>
    </div>
  );
}
