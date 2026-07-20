/**
 * ExportPreviewDialog — the "Export…" preview window. Overlay pattern follows
 * SettingsDialog (custom-DOM modal, store-driven open flag, Esc handled by the
 * global keydown listener in main.tsx); the body is a separate component so
 * its state mounts fresh on every open, like CommandPalette's.
 *
 * Layout: a toolbar (format segmented control · theme picker) over a live
 * preview iframe. The light/dark mode isn't a control — it follows the app's
 * current appearance (the `dark` seed), which picks each theme's palette mode. The iframe renders the same standalone
 * HTML the HTML export writes (sanitized preview render, inline styles, data:
 * images — CSP-safe via srcdoc, exactly like the old print path), rebuilt with
 * a short debounce whenever the theme selection changes. The preview is the
 * HTML rendering for every format: PDF follows it closely (same converter
 * family, same theme colors); DOCX keeps standard Word styles.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExportFormat } from '../../core/export/doc-source';
import { buildExportPreviewHtml, runExportFromPreview } from '../session';
import { exportPreviewStore, useExportPreview } from '../stores/export-preview';
import { exportThemeGroups, useThemeRegistry } from '../stores/theme-registry';

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: 'pdf', label: 'PDF', hint: 'A themed PDF document' },
  { value: 'docx', label: 'DOCX', hint: 'A Word document (standard Word styles)' },
  { value: 'html', label: 'HTML', hint: 'A themed standalone .html file' },
];

/** Debounce for preview rebuilds while the user flips themes. */
const PREVIEW_REBUILD_MS = 150;

export function ExportPreviewDialog() {
  const open = useExportPreview((s) => s.open);
  if (!open) {
    return null;
  }
  return <ExportPreviewBody />;
}

function ExportPreviewBody() {
  const source = useExportPreview((s) => s.source);
  const format = useExportPreview((s) => s.format);
  const themeId = useExportPreview((s) => s.themeId);
  const dark = useExportPreview((s) => s.dark);
  const plugins = useThemeRegistry((s) => s.plugins);
  const groups = useMemo(() => exportThemeGroups(plugins), [plugins]);
  const [html, setHtml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // First build renders immediately; only theme flips debounce.
  const builtOnce = useRef(false);

  const close = () => exportPreviewStore.getState().close();

  useEffect(() => {
    if (!source) {
      return;
    }
    let stale = false;
    const build = () => {
      void buildExportPreviewHtml(source, themeId, dark)
        .then((result) => {
          if (!stale) {
            builtOnce.current = true;
            setHtml(result);
          }
        })
        .catch(() => {
          // Preview failed (e.g. render error) — the export buttons still work.
        });
    };
    const timer = setTimeout(build, builtOnce.current ? PREVIEW_REBUILD_MS : 0);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [source, themeId, dark]);

  if (!source) {
    return null;
  }

  // An id the registry no longer knows still needs a visible entry, or the
  // select would silently show (but not apply) the first option.
  const known = groups.some((group) => group.some((o) => o.value === themeId));

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div className="export-dialog" role="dialog" aria-modal="true" aria-label="Export preview">
        <header className="settings-header">
          <h2 className="settings-title">Export — {source.title}</h2>
          <button className="settings-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </header>

        <div className="export-toolbar">
          <div className="export-formats" role="group" aria-label="Export format">
            {FORMATS.map(({ value, label, hint }) => (
              <button
                key={value}
                className={`export-segment${format === value ? ' export-segment-active' : ''}`}
                title={hint}
                aria-pressed={format === value}
                onClick={() => exportPreviewStore.getState().setFormat(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* DOCX keeps standard Word styles, so the theme can't apply there. */}
          <label
            className={`export-theme-label${format === 'docx' ? ' export-theme-disabled' : ''}`}
            title={
              format === 'docx' ? 'DOCX uses standard Word styles — themes do not apply' : undefined
            }
          >
            Theme
            <select
              className="settings-control export-theme-select"
              value={themeId}
              disabled={format === 'docx'}
              onChange={(e) => exportPreviewStore.getState().setThemeId(e.target.value)}
            >
              {!known && <option value={themeId}>Default</option>}
              {groups.map((group, i) => (
                <optgroup key={i} label={i === 0 ? 'Built-in' : 'Themes'}>
                  {group.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        {html === null ? (
          <div className="export-preview-loading">Rendering preview…</div>
        ) : (
          <iframe
            className="export-preview-frame"
            title="Export preview"
            sandbox="allow-same-origin"
            srcDoc={html}
          />
        )}

        <footer className="settings-footer export-footer">
          <span className="settings-hint">
            Preview shows the HTML rendering; DOCX uses standard Word styles.
          </span>
          <button className="settings-button" onClick={close}>
            Cancel
          </button>
          <button
            className="settings-button export-confirm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void runExportFromPreview().finally(() => setBusy(false));
            }}
          >
            {busy ? 'Exporting…' : `Export ${format.toUpperCase()}…`}
          </button>
        </footer>
      </div>
    </div>
  );
}
