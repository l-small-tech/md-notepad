#!/usr/bin/env node
/**
 * Regenerate the character-width range tables in src/term/charwidth.ts from
 * Unicode data. Run manually on a Unicode version bump; the output is
 * checked in so builds and CI never touch the network.
 *
 *   node scripts/gen-width-tables.mjs [unicode-version]
 *
 * Prints the ZERO_WIDTH and WIDE range literals to stdout; paste them over
 * the tables in charwidth.ts.
 *
 * Classification (matching wcwidth conventions used by xterm/WezTerm):
 *   zero  — general categories Mn, Me, Cf (minus a few visible Cf), plus
 *           Hangul jamo V/T fillers and ZWSP..ZWNJ area
 *   wide  — EastAsianWidth W and F, plus Emoji_Presentation emoji
 */

const version = process.argv[2] ?? '16.0.0';
const base = `https://www.unicode.org/Public/${version}/ucd`;

async function fetchText(path) {
  const res = await fetch(`${base}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

function parseRanges(text, wanted) {
  const ranges = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim();
    if (!body) continue;
    const [cps, value] = body.split(';').map((s) => s.trim());
    if (!wanted(value)) continue;
    const [start, end = start] = cps.split('..').map((s) => Number.parseInt(s, 16));
    ranges.push([start, end]);
  }
  return ranges;
}

function parseUnicodeDataCategories(text, categories) {
  const ranges = [];
  let rangeStart = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const fields = line.split(';');
    const cp = Number.parseInt(fields[0], 16);
    const name = fields[1];
    const category = fields[2];
    if (name.endsWith(', First>')) {
      rangeStart = categories.has(category) ? cp : null;
      continue;
    }
    if (name.endsWith(', Last>')) {
      if (rangeStart !== null) ranges.push([rangeStart, cp]);
      rangeStart = null;
      continue;
    }
    if (categories.has(category)) ranges.push([cp, cp]);
  }
  return ranges;
}

function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function subtract(ranges, removals) {
  const remove = new Set();
  for (const [start, end] of removals) {
    for (let cp = start; cp <= end; cp++) remove.add(cp);
  }
  const out = [];
  for (const [start, end] of ranges) {
    let runStart = null;
    for (let cp = start; cp <= end + 1; cp++) {
      const keep = cp <= end && !remove.has(cp);
      if (keep && runStart === null) runStart = cp;
      if (!keep && runStart !== null) {
        out.push([runStart, cp - 1]);
        runStart = null;
      }
    }
  }
  return out;
}

function format(name, ranges) {
  const parts = ranges.map(
    ([s, e]) => `[0x${s.toString(16).padStart(4, '0')}, 0x${e.toString(16).padStart(4, '0')}]`,
  );
  let body = '';
  let line = ' ';
  for (const part of parts) {
    if (line.length + part.length + 2 > 78) {
      body += `${line}\n`;
      line = ' ';
    }
    line += ` ${part},`;
  }
  body += `${line}\n`;
  return `// prettier-ignore\nconst ${name}: Ranges = [\n${body}];\n`;
}

const [eaw, unicodeData, emojiData] = await Promise.all([
  fetchText('EastAsianWidth.txt'),
  fetchText('UnicodeData.txt'),
  fetchText('emoji/emoji-data.txt'),
]);

// Zero width: Mn, Me, Cf — but keep visible/ambiguous Cf out of it the same
// way glibc wcwidth does (Arabic number signs render in most fonts, but
// terminals near-universally treat all Cf as zero; we follow terminals).
const zero = merge([
  ...parseUnicodeDataCategories(unicodeData, new Set(['Mn', 'Me', 'Cf'])),
  [0x1160, 0x11ff], // Hangul jamo vowels/finals (join with a leading jamo)
  [0x200b, 0x200f],
]);

const emojiPresentation = parseRanges(emojiData, (v) => v === 'Emoji_Presentation');
const wide = subtract(
  merge([...parseRanges(eaw, (v) => v === 'W' || v === 'F'), ...emojiPresentation]),
  zero,
);

process.stdout.write(format('ZERO_WIDTH', zero));
process.stdout.write('\n');
process.stdout.write(format('WIDE', wide));
