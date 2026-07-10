import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDocModel, type DocModel } from '../doc-model';
import {
  createModeSync,
  createWritebackGuard,
  type EditorAdapter,
  type ModeSyncOptions,
} from '../mode-sync';

/**
 * FakeAdapter — stands in for CM6/Milkdown. Real adapters must satisfy the
 * same observable behavior these tests pin down.
 */
class FakeAdapter implements EditorAdapter {
  attachCount = 0;
  attached = false;
  /** Set to make the next attach hang until resolved (lazy-load simulation). */
  attachGate: Promise<void> | null = null;
  /** Set to make attach throw (parse-failure simulation). */
  attachError: Error | null = null;
  /** Simulates the write-back flush contract of detach(). */
  onDetachFlush: (() => void) | null = null;

  constructor(
    private name: string,
    private log: string[],
  ) {}

  async attach(_host: HTMLElement, _model: DocModel): Promise<void> {
    if (this.attachGate) {
      await this.attachGate;
    }
    if (this.attachError) {
      this.log.push(`${this.name}:attach-failed`);
      throw this.attachError;
    }
    this.attachCount += 1;
    this.attached = true;
    this.log.push(`${this.name}:attach`);
  }

  detach(): void {
    this.onDetachFlush?.();
    this.attached = false;
    this.log.push(`${this.name}:detach`);
  }

  focus(): void {
    this.log.push(`${this.name}:focus`);
  }
}

function setup(overrides?: Partial<ModeSyncOptions>) {
  const log: string[] = [];
  const model = createDocModel('# doc');
  const source = new FakeAdapter('source', log);
  const wysiwyg = new FakeAdapter('wysiwyg', log);
  const wysiwygFactory = vi.fn(async () => wysiwyg);
  const onError = vi.fn();
  const sync = createModeSync({
    model,
    host: {} as HTMLElement,
    initialMode: 'raw',
    adapters: { source: () => source, wysiwyg: wysiwygFactory },
    onError,
    ...overrides,
  });
  return { log, model, source, wysiwyg, wysiwygFactory, onError, sync };
}

describe('createModeSync', () => {
  test('attaches the source adapter for the initial mode', async () => {
    const { sync, source } = setup();
    await sync.whenIdle();
    expect(source.attached).toBe(true);
    expect(sync.getMode()).toBe('raw');
  });

  test('raw ⇄ split keeps the same editor attached — no detach/attach churn', async () => {
    const { sync, source, log } = setup();
    await sync.whenIdle();
    await sync.setMode('split');
    await sync.setMode('raw');
    expect(sync.getMode()).toBe('raw');
    expect(source.attachCount).toBe(1);
    expect(log).toEqual(['source:attach']);
  });

  test('the wysiwyg chunk is not loaded until first needed (invariant I8)', async () => {
    const { sync, wysiwygFactory } = setup();
    await sync.whenIdle();
    await sync.setMode('split');
    expect(wysiwygFactory).not.toHaveBeenCalled();
    await sync.setMode('wysiwyg');
    expect(wysiwygFactory).toHaveBeenCalledOnce();
  });

  test('raw → wysiwyg detaches source, then attaches wysiwyg (in that order)', async () => {
    const { sync, log } = setup();
    await sync.whenIdle();
    await sync.setMode('wysiwyg');
    expect(log).toEqual(['source:attach', 'source:detach', 'wysiwyg:attach']);
    expect(sync.getMode()).toBe('wysiwyg');
  });

  test('adapter instances are reused across switches', async () => {
    const { sync, wysiwygFactory, source, wysiwyg } = setup();
    await sync.setMode('wysiwyg');
    await sync.setMode('raw');
    await sync.setMode('wysiwyg');
    expect(wysiwygFactory).toHaveBeenCalledOnce();
    expect(source.attachCount).toBe(2); // re-attached on the way back
    expect(wysiwyg.attachCount).toBe(2);
  });

  test('a failed lazy load leaves the source editor untouched and reverts mode', async () => {
    const { sync, source, onError } = setup({
      adapters: {
        source: () => new FakeAdapter('source', []),
        wysiwyg: () => Promise.reject(new Error('chunk failed')),
      },
    });
    await sync.whenIdle();
    await sync.setMode('wysiwyg');
    expect(sync.getMode()).toBe('raw');
    expect(onError).toHaveBeenCalledOnce();
    void source;
  });

  test('a failed wysiwyg attach re-attaches the previous editor', async () => {
    const { sync, source, wysiwyg, onError } = setup();
    await sync.whenIdle();
    wysiwyg.attachError = new Error('parse exploded');
    await sync.setMode('wysiwyg');
    expect(sync.getMode()).toBe('raw');
    expect(source.attached).toBe(true);
    expect(source.attachCount).toBe(2); // initial + revert re-attach
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'wysiwyg');
  });

  test('concurrent setMode calls are serialized, last one wins', async () => {
    const { sync, wysiwyg, log } = setup();
    await sync.whenIdle();

    let releaseAttach!: () => void;
    wysiwyg.attachGate = new Promise((resolve) => {
      releaseAttach = resolve;
    });

    const toWysiwyg = sync.setMode('wysiwyg');
    const backToRaw = sync.setMode('raw'); // queued while attach is in flight
    releaseAttach();
    await Promise.all([toWysiwyg, backToRaw]);

    expect(sync.getMode()).toBe('raw');
    expect(log).toEqual([
      'source:attach',
      'source:detach',
      'wysiwyg:attach',
      'wysiwyg:detach',
      'source:attach',
    ]);
  });

  test('dispose detaches the active editor (write-back flush point)', async () => {
    const { sync, source } = setup();
    await sync.whenIdle();
    const flushed = vi.fn();
    source.onDetachFlush = flushed;
    await sync.dispose();
    expect(source.attached).toBe(false);
    expect(flushed).toHaveBeenCalledOnce();
  });
});

describe('createWritebackGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeGuard(serialized = 'NORMALIZED') {
    const push = vi.fn();
    const serialize = vi.fn(() => serialized);
    const guard = createWritebackGuard({ serialize, push, debounceMs: 150 });
    return { guard, push, serialize };
  }

  test('programmatic transactions never trigger write-back', () => {
    const { guard, push } = makeGuard();
    guard.noteTransaction({ docChanged: true, programmatic: true });
    guard.noteTransaction({ docChanged: false, programmatic: false });
    vi.advanceTimersByTime(1000);
    guard.flushSync();
    expect(push).not.toHaveBeenCalled();
    expect(guard.hasUserEdit()).toBe(false);
  });

  test('mount → look around → leave is byte-identical (no push at all)', () => {
    // The core no-normalization-drift guarantee: without a user edit,
    // detach (which calls flushSync) must not write anything back.
    const { guard, push, serialize } = makeGuard();
    guard.noteTransaction({ docChanged: true, programmatic: true }); // initial setContent
    guard.flushSync(); // what detach() does
    expect(push).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
  });

  test('a real user edit serializes after the debounce window', () => {
    const { guard, push } = makeGuard();
    guard.noteTransaction({ docChanged: true, programmatic: false });
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(149);
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(push).toHaveBeenCalledExactlyOnceWith('NORMALIZED');
    expect(guard.hasUserEdit()).toBe(true);
  });

  test('rapid typing coalesces into one trailing serialization', () => {
    const { guard, push } = makeGuard();
    for (let i = 0; i < 10; i++) {
      guard.noteTransaction({ docChanged: true, programmatic: false });
      vi.advanceTimersByTime(100); // always inside the 150ms window
    }
    expect(push).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(push).toHaveBeenCalledOnce();
  });

  test('flushSync pushes pending work immediately (the detach contract)', () => {
    const { guard, push } = makeGuard();
    guard.noteTransaction({ docChanged: true, programmatic: false });
    guard.flushSync();
    expect(push).toHaveBeenCalledOnce();
    // And the timer must not double-push later.
    vi.advanceTimersByTime(1000);
    expect(push).toHaveBeenCalledOnce();
  });

  test('dispose cancels pending work', () => {
    const { guard, push } = makeGuard();
    guard.noteTransaction({ docChanged: true, programmatic: false });
    guard.dispose();
    vi.advanceTimersByTime(1000);
    expect(push).not.toHaveBeenCalled();
  });
});
