import { describe, expect, it } from 'vitest';
import { Terminal } from '../terminal';

/**
 * Deterministic PRNG so a failure reproduces from the seed in the test name.
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(rand() * 256);
  return bytes;
}

/** Byte soup biased toward escape-sequence structure to hit deep states. */
function structuredSoup(rand: () => number, length: number): Uint8Array {
  const interesting = [0x1b, 0x5b, 0x5d, 0x50, 0x3b, 0x3a, 0x3f, 0x07, 0x0a, 0x0d, 0x18, 0x9b];
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] =
      rand() < 0.4
        ? interesting[Math.floor(rand() * interesting.length)]!
        : Math.floor(rand() * 256);
  }
  return bytes;
}

function checkInvariants(t: Terminal): void {
  expect(t.cursor.x).toBeGreaterThanOrEqual(0);
  expect(t.cursor.x).toBeLessThan(t.cols);
  expect(t.cursor.y).toBeGreaterThanOrEqual(0);
  expect(t.cursor.y).toBeLessThan(t.rows);
  const lines = t.serialize();
  expect(lines).toHaveLength(t.rows);
}

describe('fuzz', () => {
  it('random byte soup never throws or corrupts state', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed);
      const t = new Terminal({ cols: 20, rows: 6, scrollback: 50 });
      for (let chunk = 0; chunk < 20; chunk++) {
        t.write(randomBytes(rand, 1 + Math.floor(rand() * 512)));
        checkInvariants(t);
      }
      // Still functional afterwards.
      t.write('\x1bc');
      t.write('ok');
      expect(t.serialize()[0]).toBe('ok');
    }
  });

  it('escape-structured soup never throws, across chunk boundaries', () => {
    for (let seed = 100; seed <= 120; seed++) {
      const rand = mulberry32(seed);
      const t = new Terminal({ cols: 10, rows: 4, scrollback: 10 });
      const soup = structuredSoup(rand, 4096);
      let offset = 0;
      while (offset < soup.length) {
        const size = 1 + Math.floor(rand() * 7);
        t.write(soup.subarray(offset, offset + size));
        offset += size;
      }
      checkInvariants(t);
    }
  });

  it('random resizes interleaved with output stay consistent', () => {
    const rand = mulberry32(42);
    const t = new Terminal({ cols: 10, rows: 5, scrollback: 30 });
    for (let i = 0; i < 60; i++) {
      t.write(structuredSoup(rand, 128));
      t.resize(1 + Math.floor(rand() * 40), 1 + Math.floor(rand() * 20));
      checkInvariants(t);
    }
  });
});
