/**
 * CommandPalette (Ctrl/Cmd+K) — a fuzzy-searchable list over `buildCommands()`
 * (src/ui/commands.ts, the single source of truth for app actions).
 *
 * Overlay pattern follows SettingsDialog: mounted in App, rendered only while
 * `uiStore.paletteOpen`, backdrop click closes. All keyboard handling lives on
 * the autofocused input and calls `stopPropagation()`, so the global keydown
 * listener in main.tsx never sees palette keys (it additionally ignores
 * shortcuts while the palette is open, as a belt-and-braces guard).
 *
 * The inner body is a separate component so its hooks (query/selection state)
 * mount fresh each time the palette opens — reopening always starts with an
 * empty query and the first row selected.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { rankCandidates } from '../../core/fuzzy';
import { buildCommands, type AppCommand } from '../commands';
import { uiStore, useUiStore } from '../stores/ui';

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  if (!open) {
    return null;
  }
  return <PaletteBody />;
}

function PaletteBody() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Snapshot the command table once per open (titles/enabled don't change
  // while the palette is up); ranking re-runs per keystroke.
  const commands = useMemo(() => buildCommands().filter((c) => !c.enabled || c.enabled()), []);
  const ranked = useMemo(
    () => rankCandidates(query, commands, (c) => c.title + ' ' + (c.keywords ?? []).join(' ')),
    [query, commands],
  );

  // Typing can shrink the list under the selection — clamp instead of losing it.
  const sel = ranked.length === 0 ? 0 : Math.min(selected, ranked.length - 1);

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' });
  }, [sel, ranked]);

  const close = () => uiStore.getState().closePalette();
  const run = (cmd: AppCommand) => {
    close();
    cmd.run();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // The palette owns its keys — never let the global shortcut listener or
    // an editor underneath react to them.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (ranked.length > 0) {
        setSelected((sel + 1) % ranked.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (ranked.length > 0) {
        setSelected((sel - 1 + ranked.length) % ranked.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = ranked[sel];
      if (cmd) {
        run(cmd);
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
      // mod+K toggles: pressing it again with the palette open closes it.
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
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          className="palette-input"
          type="text"
          placeholder="Type a command…"
          aria-label="Search commands"
          spellCheck={false}
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul className="palette-list" ref={listRef} role="listbox">
          {ranked.map((cmd, i) => (
            <li
              key={cmd.id}
              className={`palette-item${i === sel ? ' is-selected' : ''}`}
              role="option"
              aria-selected={i === sel}
              // Keep focus in the input so the keyboard keeps working after a
              // press that doesn't complete as a click.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setSelected(i)}
              onClick={() => run(cmd)}
            >
              <span className="palette-item-title">{cmd.title}</span>
              {cmd.shortcut && <span className="palette-item-shortcut">{cmd.shortcut}</span>}
            </li>
          ))}
          {ranked.length === 0 && <li className="palette-empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
