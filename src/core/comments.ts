/**
 * comments.ts — the pure data layer for voice notes (invariant: no I/O here).
 *
 * A voice note is a short dictated note about one line of a markdown file. The
 * note never touches the file it comments on: the parent `.md` stays byte-for-
 * byte unchanged (no markers, no checksum churn, nothing for a sync client to
 * merge). Everything lives in a sibling human-readable file, `<name>.comments.md`,
 * whose entries each carry an obvious reference back to the parent — its file
 * name, the 1-based line the note is about, a quote of that line's text as it
 * read at capture time, and a UTC timestamp. The quote is what keeps a note
 * findable after the parent is edited and the line number drifts.
 *
 * The intended reader of that file is as often an AI agent as a person — the
 * author reviews a document on a phone, dictates notes, then hands the sidecar
 * to an agent to act on — so the format is plain, regular markdown with every
 * field spelled out.
 *
 * This module owns the pure concerns the rest of the feature composes: locating
 * the comments file, parsing/serializing it, and minting collision-free ids.
 * Everything here is synchronous and side-effect-free so it is exhaustively
 * unit-testable; the storage-provider round-trip and the UI live elsewhere.
 *
 * File format (v2):
 *
 *     <!-- md-notepad voice comments v2 -->
 *     # Voice notes for [meeting-notes.md](./meeting-notes.md)
 *
 *     ## ^c3f9a
 *     - file: meeting-notes.md
 *     - line: 42
 *     - time: 2026-09-10T21:32:07.000Z
 *
 *     > The original line's text, quoted at capture time
 *
 *     Ship the pricing change before the demo.
 *
 * v1 files (which had no file/line/quote fields — the parent carried an
 * invisible `<!-- ^cXXXX -->` anchor instead) still parse; the missing fields
 * come back empty. Nothing writes v1 any more.
 */

import { baseName, dirName, extName, joinPath } from './session/plan-flush';

/** A single voice note as stored in `<name>.comments.md`. */
export interface VoiceComment {
  /** Entry id (without the `^`), e.g. `c3f9a`. Unique within the file. */
  id: string;
  /** Name of the file the note is about (no directory), e.g. `meeting-notes.md`. */
  file: string;
  /** 1-based line the note is about; null for a legacy (v1) entry. */
  line: number | null;
  /** The text of that line at capture time (single line, trimmed); '' if unknown. */
  quote: string;
  /** ISO-8601 UTC capture time (`new Date().toISOString()`). */
  time: string;
  /** The dictated/typed text. May be empty for a desktop record-only note. */
  transcript: string;
  /** Optional sibling audio file name (desktop record path); null/absent otherwise. */
  audio?: string | null;
}

/** First line of every comments file — a version stamp and a human hint. */
const HEADER_V2 = '<!-- md-notepad voice comments v2 -->';
const HEADER_VERSION_RE = /^<!--\s*md-notepad voice comments v(\d+)\s*-->\s*$/;

/**
 * Sibling comments-file path for a note: `foo.md` → `foo.comments.md`, in the
 * same directory / same provider namespace (so a `saf://…` note yields a
 * `saf://…` comments path). A `.markdown` note also collapses to `.comments.md`.
 */
export function commentsPathFor(notePath: string): string {
  const ext = extName(notePath); // '.md' | '.markdown' | ''
  const base = baseName(notePath);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  const file = `${stem}.comments.md`;
  const dir = dirName(notePath);
  return dir ? joinPath(dir, file) : file;
}

/** True for a comments-file name/path (`*.comments.md`), used to hide them. */
export function isCommentsPath(path: string): boolean {
  return baseName(path).toLowerCase().endsWith('.comments.md');
}

/**
 * Mint an id that collides with none of `existingIds`. `c` + 4 base36 chars
 * gives ~1.7M values; the retry loop makes uniqueness deterministic regardless.
 */
export function newCommentId(existingIds: Set<string>): string {
  for (;;) {
    const id = 'c' + Math.random().toString(36).slice(2, 6).padStart(4, '0');
    if (!existingIds.has(id)) {
      return id;
    }
  }
}

/**
 * The 1-based line's text from a document, trimmed to one line — the quote
 * stored beside a note. '' when the line is out of range.
 */
export function lineQuote(docText: string, line: number): string {
  const lines = docText.split('\n');
  const raw = lines[line - 1];
  return raw === undefined ? '' : raw.replace(/\r$/, '').trim();
}

const ENTRY_RE = /^##\s+\^(c[0-9a-z]+)\s*$/;
const META_RE = /^-\s+(file|line|time|audio):\s*(.*)$/;

/**
 * Parse a `<name>.comments.md` file into notes, in file order. Tolerant of a
 * missing header and of hand-edits: each `## ^id` heading starts an entry; the
 * leading run of `- key:` lines is metadata. In a v2 file a blockquote run right
 * after the metadata is the line quote. Everything after that (trimmed) is the
 * transcript verbatim — so dashes or lists inside a transcript are preserved.
 * Unknown/garbage lines before the first entry (including the title) are ignored.
 */
export function parseCommentsFile(text: string): VoiceComment[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const first = lines[0] ?? '';
  const versionMatch = HEADER_VERSION_RE.exec(first);
  const version = versionMatch ? Number(versionMatch[1]) : 1;

  const out: VoiceComment[] = [];
  interface Cur {
    id: string;
    file: string;
    line: number | null;
    time: string;
    audio: string | null;
    body: string[];
  }
  let cur: Cur | null = null;
  // 'meta' → the leading `- key:` run; 'quote' → an optional `>` run (v2 only);
  // 'body' → everything else.
  let section: 'meta' | 'quote' | 'body' = 'body';
  let quoteLines: string[] = [];

  const flush = () => {
    if (cur) {
      out.push({
        id: cur.id,
        file: cur.file,
        line: cur.line,
        quote: quoteLines.join(' ').trim(),
        time: cur.time,
        audio: cur.audio,
        transcript: cur.body.join('\n').trim(),
      });
    }
    quoteLines = [];
  };

  for (const line of lines) {
    const head = ENTRY_RE.exec(line);
    if (head) {
      flush();
      cur = { id: head[1]!, file: '', line: null, time: '', audio: null, body: [] };
      section = 'meta';
      continue;
    }
    if (!cur) {
      continue; // preamble before the first entry
    }
    if (section === 'meta') {
      const meta = META_RE.exec(line);
      if (meta) {
        const v = meta[2]!.trim();
        switch (meta[1]) {
          case 'file':
            cur.file = v;
            break;
          case 'line': {
            const n = Number.parseInt(v, 10);
            cur.line = Number.isFinite(n) && n > 0 ? n : null;
            break;
          }
          case 'time':
            cur.time = v;
            break;
          case 'audio':
            cur.audio = v ? v : null;
            break;
        }
        continue;
      }
      // The blank separator (or the first non-meta line) ends the meta run.
      section = version >= 2 ? 'quote' : 'body';
      if (line.trim() === '') {
        continue;
      }
    }
    if (section === 'quote') {
      if (/^>/.test(line)) {
        quoteLines.push(line.replace(/^>\s?/, ''));
        continue;
      }
      section = 'body';
      if (line.trim() === '' && quoteLines.length > 0) {
        continue; // the blank line between the quote and the transcript
      }
      if (line.trim() === '' && cur.body.length === 0) {
        continue; // stray blank before the body
      }
    }
    cur.body.push(line);
  }
  flush();
  return out;
}

/**
 * Serialize notes to the canonical v2 `<name>.comments.md` text. `noteFile` is
 * the parent's file name (no directory) — it titles the file and fills in the
 * `file:` field of any legacy entry that has none.
 */
export function serializeCommentsFile(comments: VoiceComment[], noteFile: string): string {
  const blocks = comments.map((c) => {
    const file = c.file || noteFile;
    const meta = [`- file: ${file}`];
    if (c.line !== null) {
      meta.push(`- line: ${c.line}`);
    }
    meta.push(`- time: ${c.time}`);
    if (c.audio) {
      meta.push(`- audio: ${c.audio}`);
    }
    const quote = c.quote.trim();
    const quoteBlock = quote ? `> ${quote}\n\n` : '';
    const body = c.transcript.trim();
    return `## ^${c.id}\n${meta.join('\n')}\n\n${quoteBlock}${body}\n`;
  });
  const title = `# Voice notes for [${noteFile}](./${encodeURI(noteFile)})`;
  return `${HEADER_V2}\n${title}\n\n${blocks.join('\n')}`;
}
