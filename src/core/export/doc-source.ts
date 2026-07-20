/**
 * Shared export vocabulary (pure). `DocSource` is one document ready to
 * export, whatever it came from — an open tab's live text or a file read off
 * disk. It lives in core so both the export-preview store (ui/stores) and the
 * session exporter (ui/session) can import it without a stores → session
 * dependency.
 */

export interface DocSource {
  markdown: string;
  title: string;
  /** Anchors relative image resolution; null for an unsaved document. */
  docPath: string | null;
  /** Extensionless basename for the save dialog's suggested filename. */
  suggestedBase: string;
}

/** The formats the export preview offers. */
export type ExportFormat = 'html' | 'pdf' | 'docx';
