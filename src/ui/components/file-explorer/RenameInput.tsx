import { useEffect, useRef } from 'react';

/**
 * Inline rename field for an explorer row — same interaction contract as the
 * TabBar's rename input: Enter/blur commit, Escape cancels (onDone(null)).
 * Rendered in place of the row's button so row clicks can't fire mid-edit.
 */
export function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => onDone(ref.current?.value ?? null);
  return (
    <input
      ref={ref}
      className="explorer-rename-input"
      defaultValue={initial}
      aria-label="Rename"
      onBlur={commit}
      onKeyDown={(e) => {
        // Keep these off the global shortcut listener.
        e.stopPropagation();
        if (e.key === 'Enter') {
          commit();
        } else if (e.key === 'Escape') {
          onDone(null);
        }
      }}
    />
  );
}
