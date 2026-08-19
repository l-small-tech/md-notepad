import { describe, expect, it, vi } from 'vitest';
import { Channel } from '@tauri-apps/api/core';
import { IpcError, type PtyMessage, type PtySpawnArgs } from '../commands';
import {
  createTauriPtyProvider,
  normalizeSpawnOptions,
  toBytes,
  type PtyHandlers,
  type PtyIpc,
} from '../pty';

/**
 * A fake Tauri channel. The real one registers a callback on
 * `window.__TAURI_INTERNALS__` at construction, which does not exist outside
 * the app — this stands in for it so the actual provider (not a mock of it)
 * is what these tests exercise.
 */
class FakeChannel {
  onmessage: (message: PtyMessage) => void = () => {};
}

function harness(overrides: Partial<PtyIpc> = {}) {
  const channel = new FakeChannel();
  const calls: {
    spawned?: PtySpawnArgs;
    writes: number[][];
    resizes: number[][];
    kills: number[];
  } = { writes: [], resizes: [], kills: [] };

  const ipc: PtyIpc = {
    defaultShell: () => Promise.resolve('/bin/bash'),
    ptySpawn: (options) => {
      calls.spawned = options;
      return Promise.resolve(7);
    },
    ptyWrite: (_id, data) => {
      calls.writes.push([...data]);
      return Promise.resolve();
    },
    ptyResize: (_id, cols, rows) => {
      calls.resizes.push([cols, rows]);
      return Promise.resolve();
    },
    ptyKill: (id) => {
      calls.kills.push(id);
      return Promise.resolve();
    },
    ...overrides,
  };

  const provider = createTauriPtyProvider(ipc, () => channel as unknown as Channel<PtyMessage>);
  return { provider, channel, calls };
}

function handlers(): PtyHandlers & { data: number[][]; exits: number[]; closes: number } {
  const seen = {
    data: [] as number[][],
    exits: [] as number[],
    closes: 0,
    onData: (bytes: Uint8Array) => seen.data.push([...bytes]),
    onExit: (code: number) => seen.exits.push(code),
    onClose: () => (seen.closes += 1),
  };
  return seen;
}

describe('toBytes', () => {
  it('unwraps the ArrayBuffer the raw IPC path delivers', () => {
    const source = Uint8Array.from([104, 105]);
    expect([...toBytes(source.buffer)]).toEqual([104, 105]);
  });

  it('accepts the shapes a different runtime might hand back', () => {
    expect([...toBytes(Uint8Array.from([1, 2]))]).toEqual([1, 2]);
    expect([...toBytes([3, 4])]).toEqual([3, 4]);
  });

  it('preserves bytes that are not valid UTF-8', () => {
    // Output is decoded downstream by the engine, never here — a lone
    // continuation byte at a chunk boundary must survive this layer intact.
    expect([...toBytes(Uint8Array.from([0xf0, 0x9f]).buffer)]).toEqual([0xf0, 0x9f]);
  });
});

describe('normalizeSpawnOptions', () => {
  it('floors fractional cell counts from a fractional-DPI layout', () => {
    const args = normalizeSpawnOptions({ cols: 100.9, rows: 30.2 });
    expect(args).toMatchObject({ cols: 100, rows: 30 });
  });

  it('never asks for a zero-sized pty', () => {
    expect(normalizeSpawnOptions({ cols: 0, rows: -5 })).toMatchObject({ cols: 1, rows: 1 });
  });

  it('omits program and cwd so Rust picks the login shell and inherits cwd', () => {
    const args = normalizeSpawnOptions({ cols: 80, rows: 24 });
    expect('program' in args).toBe(false);
    expect('cwd' in args).toBe(false);
    expect(args).toMatchObject({ args: [], env: {} });
  });

  it('passes a profile through untouched', () => {
    expect(
      normalizeSpawnOptions({
        cols: 80,
        rows: 24,
        program: 'claude',
        args: ['--continue'],
        cwd: '/tmp',
        env: { NO_COLOR: '1' },
      }),
    ).toEqual({
      cols: 80,
      rows: 24,
      program: 'claude',
      args: ['--continue'],
      cwd: '/tmp',
      env: { NO_COLOR: '1' },
    });
  });
});

describe('the Tauri pty provider', () => {
  it('routes output bytes and control messages to the right handler', async () => {
    const { provider, channel } = harness();
    const seen = handlers();
    await provider.spawn({ cols: 80, rows: 24 }, seen);

    channel.onmessage(Uint8Array.from([104, 105]).buffer);
    channel.onmessage({ type: 'exit', code: 3 });
    channel.onmessage({ type: 'closed' });

    expect(seen.data).toEqual([[104, 105]]);
    expect(seen.exits).toEqual([3]);
    expect(seen.closes).toBe(1);
  });

  it('is listening before spawn resolves, so no early output is lost', async () => {
    const channel = new FakeChannel();
    const seen = handlers();
    const ipc = {
      defaultShell: () => Promise.resolve('/bin/sh'),
      // A shell that prints its prompt before the invoke promise settles.
      ptySpawn: () => {
        channel.onmessage(Uint8Array.from([36, 32]).buffer);
        return Promise.resolve(1);
      },
      ptyWrite: () => Promise.resolve(),
      ptyResize: () => Promise.resolve(),
      ptyKill: () => Promise.resolve(),
    } satisfies PtyIpc;

    const provider = createTauriPtyProvider(ipc, () => channel as unknown as Channel<PtyMessage>);
    await provider.spawn({ cols: 80, rows: 24 }, seen);

    expect(seen.data).toEqual([[36, 32]]);
  });

  it('encodes string writes as UTF-8', async () => {
    const { provider, calls } = harness();
    const handle = await provider.spawn({ cols: 80, rows: 24 }, handlers());

    await handle.write('é\n');
    await handle.write(Uint8Array.from([3]));

    expect(calls.writes).toEqual([[0xc3, 0xa9, 0x0a], [3]]);
  });

  it('ignores resize and kill for a session that already exited', async () => {
    const gone = () => Promise.reject(new IpcError('NOT_FOUND', 'no pty session 7'));
    const { provider } = harness({ ptyResize: gone, ptyKill: gone });
    const handle = await provider.spawn({ cols: 80, rows: 24 }, handlers());

    await expect(handle.resize(100, 30)).resolves.toBeUndefined();
    await expect(handle.kill()).resolves.toBeUndefined();
  });

  it('still reports real failures', async () => {
    const broken = () => Promise.reject(new IpcError('IO', 'ioctl failed'));
    const { provider } = harness({ ptyResize: broken, ptyWrite: broken });
    const handle = await provider.spawn({ cols: 80, rows: 24 }, handlers());

    await expect(handle.resize(100, 30)).rejects.toThrow('ioctl failed');
    await expect(handle.write('x')).rejects.toThrow('ioctl failed');
  });

  it('clamps a resize from a collapsed pane', async () => {
    const { provider, calls } = harness();
    const handle = await provider.spawn({ cols: 80, rows: 24 }, handlers());

    await handle.resize(0, 12.7);

    expect(calls.resizes).toEqual([[1, 12]]);
  });

  it('surfaces a spawn failure to the caller', async () => {
    const { provider } = harness({
      ptySpawn: () => Promise.reject(new IpcError('SPAWN', 'no such file')),
    });
    const onData = vi.fn();

    await expect(
      provider.spawn({ cols: 80, rows: 24, program: 'nope' }, { onData }),
    ).rejects.toThrow('no such file');
    expect(onData).not.toHaveBeenCalled();
  });
});
