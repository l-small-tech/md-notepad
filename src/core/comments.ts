/**
 * comments.ts — the pure data layer for voice comments (invariant: no I/O here).
 *
 * A voice comment is a short dictated note anchored to a point in a markdown
 * file. The anchor is an invisible HTML comment — `<!-- ^cXXXX -->` — inserted
 * into the parent `.md` at the end of the anchored line. Because it is ordinary
 * document text it moves with edits automatically, survives save/restore, and is
 * stripped from the rendered preview (the pipeline has no `allowDangerousHtml`).
 *
 * The transcripts live in a sibling human-readable file, `<name>.comments.md`,
 * keyed by the same token id. This module owns the four pure concerns the rest
 * of the feature composes: locating the comments file, parsing/serializing it,
 * scanning a document for anchors, and minting collision-free ids. Everything
 * here is synchronous and side-effect-free so it is exhaustively unit-testable;
 * the storage-provider round-trip and CM6 wiring live elsewhere.
 */

import { baseName, dirName, extName, joinPath } from './session/plan-flush';

/** A single anchored voice comment as stored in `<name>.comments.md`. */
export interface VoiceComment {
  /** Token id (without the `^`), e.g. `c3f9a`. Matches the parent `.md` marker. */
  id: string;
  /** ISO-8601 capture time (`new Date().toISOString()`). */
  time: string;
  /** The dictated/typed text. May be empty for a desktop record-only comment. */
  transcript: string;
  /** Optional sibling audio file name (desktop record path); null/absent otherwise. */
  audio?: string | null;
}

/** An anchor token located within a document string. */
export interface Anchor {
  id: string;
  /** Document offset of the `<` that opens the token. */
  from: number;
  /** Document offset just past the `>` that closes the token. */
  to: number;
  /** 1-based line the token sits on. */
  line: number;
}

/** First line of every comments file — a version stamp and a human hint. */
const HEADER = '<!-- md-notepad voice comments v1 -->';

/**
 * Matches an anchor token and captures its id. Global + sticky-free so it can be
 * reused with `matchAll`/`exec`; callers that keep state must reset `lastIndex`.
 * The id is `c` followed by base36 chars (see `newCommentId`).
 */
export const ANCHOR_RE = /<!--\s*\^(c[0-9a-z]+)\s*-->/g;

/** The exact text inserted into a `.md` to anchor a comment (leading space). */
export function insertAnchorText(id: string): string {
  return ` <!-- ^${id} -->`;
}

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
 * Scan a document for anchor tokens, in document order. Line numbers are 1-based
 * and derived from newline counts so the result maps directly onto CM6 lines.
 */
export function findAnchors(docText: string): Anchor[] {
  const out: Anchor[] = [];
  const re = new RegExp(ANCHOR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(docText)) !== null) {
    const from = m.index;
    out.push({
      id: m[1]!,
      from,
      to: from + m[0].length,
      // Count newlines up to the token: cheap and correct for any line ending
      // whose final char is '\n' (LF and CRLF both qualify).
      line: countLines(docText, from),
    });
  }
  return out;
}

function countLines(text: string, upTo: number): number {
  let n = 1;
  for (let i = 0; i < upTo; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      n++;
    }
  }
  return n;
}

/**
 * Mint an id that collides with none of `existingIds` — pass the union of ids
 * already in the parent `.md` (`findAnchors`) and in the comments file so the
 * new token is unique across both. `c` + 4 base36 chars gives ~1.7M values;
 * the retry loop makes uniqueness deterministic regardless.
 */
export function newCommentId(existingIds: Set<string>): string {
  for (;;) {
    const id = 'c' + Math.random().toString(36).slice(2, 6).padStart(4, '0');
    if (!existingIds.has(id)) {
      return id;
    }
  }
}

const HEADER_RE = /^##\s+\^(c[0-9a-z]+)\s*$/;
const META_RE = /^-\s+(time|audio):\s*(.*)$/;

/**
 * Parse a `<name>.comments.md` file into comments, in file order. Tolerant of a
 * missing header and of hand-edits: each `## ^id` heading starts an entry; the
 * leading run of `- time:` / `- audio:` lines is metadata, and everything after
 * the first non-metadata line (trimmed) is the transcript verbatim — so dashes
 * or lists inside a transcript are preserved. Unknown/garbage lines before the
 * first heading are ignored.
 */
export function parseCommentsFile(text: string): VoiceComment[] {
  const lines = text.split('\n');
  const out: VoiceComment[] = [];
  let cur: { id: string; time: string; audio: string | null; body: string[] } | null = null;
  let inMeta = false;

  const flush = () => {
    if (cur) {
      out.push({
        id: cur.id,
        time: cur.time,
        audio: cur.audio,
        transcript: cur.body.join('\n').trim(),
      });
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const head = HEADER_RE.exec(line);
    if (head) {
      flush();
      cur = { id: head[1]!, time: '', audio: null, body: [] };
      inMeta = true;
      continue;
    }
    if (!cur) {
      continue; // preamble before the first entry
    }
    if (inMeta) {
      const meta = META_RE.exec(line);
      if (meta) {
        if (meta[1] === 'time') {
          cur.time = meta[2]!.trim();
        } else {
          const v = meta[2]!.trim();
          cur.audio = v ? v : null;
        }
        continue;
      }
      if (line.trim() === '') {
        continue; // blank line between metadata and transcript
      }
      inMeta = false; // first real content line ends the metadata run
    }
    cur.body.push(line);
  }
  flush();
  return out;
}

/** Serialize comments back to the canonical `<name>.comments.md` text. */
export function serializeCommentsFile(comments: VoiceComment[]): string {
  const blocks = comments.map((c) => {
    const meta = [`- time: ${c.time}`];
    if (c.audio) {
      meta.push(`- audio: ${c.audio}`);
    }
    const body = c.transcript.trim();
    return `## ^${c.id}\n${meta.join('\n')}\n\n${body}\n`;
  });
  return `${HEADER}\n\n${blocks.join('\n')}`;
}
