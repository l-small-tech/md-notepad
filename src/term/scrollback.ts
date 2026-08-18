/**
 * Scrollback ring buffer.
 *
 * A fixed-capacity ring so that evicting the oldest line when full is O(1) —
 * `cat` on a 10 MB file scrolls ~100k lines through here, so an array-shift
 * implementation would be quadratic.
 */

import type { Row } from './row';

export class Scrollback {
  private buffer: (Row | undefined)[];
  private head = 0; // index of the oldest line
  private count = 0;

  constructor(public capacity: number) {
    this.buffer = new Array<Row | undefined>(Math.max(0, capacity));
  }

  get length(): number {
    return this.count;
  }

  /** Append a line, evicting the oldest when at capacity. */
  push(row: Row): void {
    if (this.capacity === 0) return;
    if (this.count < this.capacity) {
      this.buffer[(this.head + this.count) % this.capacity] = row;
      this.count++;
    } else {
      this.buffer[this.head] = row;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Remove and return the newest line (used to refill the grid on resize). */
  pop(): Row | undefined {
    if (this.count === 0) return undefined;
    this.count--;
    const i = (this.head + this.count) % this.capacity;
    const row = this.buffer[i];
    this.buffer[i] = undefined;
    return row;
  }

  /** `index` 0 is the oldest retained line. */
  get(index: number): Row | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.buffer[(this.head + index) % this.capacity];
  }

  clear(): void {
    this.buffer = new Array<Row | undefined>(this.capacity);
    this.head = 0;
    this.count = 0;
  }

  /** Change capacity, keeping the newest lines. */
  setCapacity(capacity: number): void {
    capacity = Math.max(0, capacity);
    const keep = Math.min(this.count, capacity);
    const next = new Array<Row | undefined>(capacity);
    for (let i = 0; i < keep; i++) {
      next[keep - 1 - i] = this.get(this.count - 1 - i);
    }
    this.buffer = next;
    this.head = 0;
    this.count = keep;
    this.capacity = capacity;
  }
}
