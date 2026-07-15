/**
 * Pure PDF-text-layout → markdown reconstruction. Takes pdf.js-shaped plain
 * items (no pdf.js types, so tests need no pdf.js) and best-effort rebuilds
 * lines, paragraphs, headings, and bullet lists from raw glyph positions.
 * Extracted images ride along as pseudo-items placed by their y position so
 * they interleave with the text roughly where they appeared on the page.
 */

import { imagePlaceholder } from './registry';

/** One text run from getTextContent(): PDF user-space coords (y grows UP). */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  /** Approximate font size in user-space units. */
  size: number;
}

/** An extracted image, anchored at the y where it was painted. */
export interface PdfImageItem {
  imageIndex: number;
  y: number;
}

interface Line {
  y: number;
  size: number;
  text: string;
  image?: number;
}

/** Mode of the line font sizes (the body-text size), or 0 for no lines. */
function bodySize(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) {
    if (l.image === undefined && l.text.trim()) {
      const s = Math.round(l.size * 2) / 2;
      counts.set(s, (counts.get(s) ?? 0) + l.text.length);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [s, c] of counts) {
    if (c > bestCount) {
      best = s;
      bestCount = c;
    }
  }
  return best;
}

/** Group sorted items into visual lines; images become one-line entries. */
function buildLines(items: PdfTextItem[], images: PdfImageItem[]): Line[] {
  const lines: Line[] = [];
  const sorted = [...items]
    .filter((it) => it.str.trim().length > 0 || it.str === ' ')
    .sort((a, b) => b.y - a.y || a.x - b.x);
  let current: {
    y: number;
    size: number;
    parts: { x: number; str: string; size: number }[];
  } | null = null;
  const flush = () => {
    if (!current) {
      return;
    }
    let text = '';
    let prevEnd: number | null = null;
    for (const p of current.parts) {
      if (prevEnd !== null && p.x - prevEnd > 0.3 * current.size && !text.endsWith(' ')) {
        text += ' ';
      }
      text += p.str;
      // Approximate run width: glyphs are ~0.5em on average.
      prevEnd = p.x + p.str.length * current.size * 0.5;
    }
    lines.push({ y: current.y, size: current.size, text: text.trimEnd() });
    current = null;
  };
  for (const it of sorted) {
    const size = it.size || 10;
    if (current && Math.abs(it.y - current.y) < 0.5 * Math.max(size, current.size)) {
      current.parts.push({ x: it.x, str: it.str, size });
      current.size = Math.max(current.size, size);
    } else {
      flush();
      current = { y: it.y, size, parts: [{ x: it.x, str: it.str, size }] };
    }
  }
  flush();
  for (const img of images) {
    lines.push({ y: img.y, size: 0, text: '', image: img.imageIndex });
  }
  return lines.sort((a, b) => b.y - a.y);
}

/** Median gap between consecutive text lines (paragraph-break yardstick). */
function medianGap(lines: Line[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i]!;
    const above = lines[i - 1]!;
    if (cur.image === undefined && above.image === undefined) {
      gaps.push(above.y - cur.y);
    }
  }
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

const BULLET = /^\s*([•◦▪‣·*]|-)\s+/;

/** Escape a leading character that would change markdown semantics. */
function escapeLead(text: string): string {
  return /^([#>]|\d+\.\s)/.test(text) ? `\\${text}` : text;
}

/** Merge a wrapped continuation line into `para`, de-hyphenating. */
function joinWrapped(para: string, next: string): string {
  if (/[a-z]-$/.test(para) && /^[a-z]/.test(next)) {
    return para.slice(0, -1) + next;
  }
  return `${para} ${next}`;
}

/**
 * Markdown for one page's text runs + image anchors. Empty string for an
 * empty page.
 */
export function pageToMarkdown(items: PdfTextItem[], images: PdfImageItem[] = []): string {
  const lines = buildLines(items, images);
  if (lines.length === 0) {
    return '';
  }
  const body = bodySize(lines);
  const gap = medianGap(lines);
  const blocks: string[] = [];
  let para: string | null = null;
  let prev: Line | null = null;
  const endPara = () => {
    if (para !== null && para.trim()) {
      blocks.push(para);
    }
    para = null;
  };
  for (const line of lines) {
    if (line.image !== undefined) {
      endPara();
      blocks.push(imagePlaceholder(line.image));
      prev = line;
      continue;
    }
    const text = line.text.trim();
    if (!text) {
      prev = line;
      continue;
    }
    const isBullet = BULLET.test(text);
    const heading =
      body > 0 && text.length < 80 && line.size >= 1.4 * body
        ? '# '
        : body > 0 && text.length < 80 && line.size >= 1.15 * body
          ? '## '
          : '';
    const bigGap =
      prev !== null && prev.image === undefined && gap > 0 && prev.y - line.y > 1.5 * gap;
    const sizeChange = prev !== null && prev.size > 0 && Math.abs(line.size - prev.size) > 0.5;
    if (heading) {
      endPara();
      blocks.push(heading + escapeLead(text.replace(BULLET, '')).trim());
    } else if (isBullet) {
      endPara();
      blocks.push(`- ${text.replace(BULLET, '').trim()}`);
    } else if (para === null || bigGap || sizeChange || prev?.image !== undefined) {
      endPara();
      para = escapeLead(text);
    } else {
      para = joinWrapped(para, text);
    }
    prev = line;
  }
  endPara();
  return blocks.join('\n\n');
}

/** Join per-page markdown blocks into one document. */
export function pagesToMarkdown(pages: string[]): string {
  return pages.filter((p) => p.trim().length > 0).join('\n\n') + '\n';
}
