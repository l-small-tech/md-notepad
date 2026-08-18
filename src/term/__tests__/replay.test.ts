/**
 * Snapshot replay tests — the regression net for real-world compatibility.
 *
 * Each fixture is a raw byte stream recorded from a live application inside
 * an 80x24 tmux session (scripts/record-fixture.sh), paired with the screen
 * tmux itself ended up with (`tmux capture-pane`). Replaying the bytes
 * through our engine must reproduce that screen exactly.
 *
 * Every compatibility bug found later (Phase 7) gets a fixture here first.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Terminal } from '../terminal';

const FIXTURES = join(__dirname, 'fixtures');
const COLS = 80;
const ROWS = 24;

function replay(name: string, chunkSize?: number): string[] {
  const bytes = readFileSync(join(FIXTURES, `${name}.bin`));
  const t = new Terminal({ cols: COLS, rows: ROWS });
  if (chunkSize === undefined) {
    t.write(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      t.write(bytes.subarray(i, i + chunkSize));
    }
  }
  return t.serialize().map((line) => line.trimEnd());
}

function expected(name: string): string[] {
  const text = readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
  const lines = text.split('\n').map((line) => line.trimEnd());
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline
  while (lines.length < ROWS) lines.push('');
  return lines;
}

const names = ['vim-edit', 'htop-view', 'less-scroll', 'colors', 'claude-code'];

describe('fixture replay', () => {
  for (const name of names) {
    it(`${name} reproduces the reference screen`, () => {
      expect(replay(name)).toEqual(expected(name));
    });

    it(`${name} is chunk-boundary independent`, () => {
      expect(replay(name, 7)).toEqual(replay(name));
    });
  }
});
