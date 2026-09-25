import { describe, expect, it } from 'vitest';
import type { Channel } from '@tauri-apps/api/core';
import type { GitNetResult, GitOutputEvent } from '../commands';
import { createGitNetRunner, type GitNetIpc } from '../git-ops';

/** Stands in for the Tauri channel, which needs the app's runtime to construct. */
class FakeChannel {
  onmessage: (message: GitOutputEvent) => void = () => {};
}

interface Deferred {
  resolve: (result: GitNetResult) => void;
  reject: (err: unknown) => void;
}

function harness() {
  const channels: FakeChannel[] = [];
  const calls: { kind: string; args: unknown[] }[] = [];
  const cancels: number[] = [];
  const pending: Deferred[] = [];
  const later = (kind: string, args: unknown[]): Promise<GitNetResult> => {
    calls.push({ kind, args });
    return new Promise<GitNetResult>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  const ipc: GitNetIpc = {
    gitFetch: (root, remote, prune, opId) => later('fetch', [root, remote, prune, opId]),
    gitPull: (root, opId) => later('pull', [root, opId]),
    gitPush: (root, remote, setUpstream, opId) => later('push', [root, remote, setUpstream, opId]),
    gitOpCancel: (opId) => {
      cancels.push(opId);
      return Promise.resolve();
    },
  };
  let id = 100;
  const run = createGitNetRunner({
    ipc,
    channel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return channel as unknown as Channel<GitOutputEvent>;
    },
    nextId: () => {
      id += 1;
      return id;
    },
  });
  return { run, channels, calls, cancels, pending };
}

const ok: GitNetResult = { ok: true, exitCode: 0, stderr: '', merge: null };

describe('createGitNetRunner', () => {
  it('allocates the op id before invoking and passes each kind its own arguments', () => {
    const h = harness();
    h.run('fetch', { root: '/r', prune: true }, () => {});
    h.run('pull', { root: '/r' }, () => {});
    h.run('push', { root: '/r', remote: 'origin', setUpstream: true }, () => {});
    expect(h.calls).toEqual([
      { kind: 'fetch', args: ['/r', null, true, 101] },
      { kind: 'pull', args: ['/r', 102] },
      { kind: 'push', args: ['/r', 'origin', true, 103] },
    ]);
    expect(h.channels).toHaveLength(3);
  });

  it('forwards streamed lines until the op settles, then drops stragglers', async () => {
    const h = harness();
    const lines: string[] = [];
    const op = h.run('push', { root: '/r' }, (line) => lines.push(`${line.stream}:${line.text}`));
    const channel = h.channels[0]!;
    channel.onmessage({ kind: 'line', stream: 'err', text: 'Writing objects: 50%' });
    channel.onmessage({ kind: 'line', stream: 'out', text: 'done' });
    channel.onmessage({ kind: 'done' });
    h.pending[0]!.resolve(ok);
    await expect(op.done).resolves.toEqual(ok);
    channel.onmessage({ kind: 'line', stream: 'err', text: 'late' });
    expect(lines).toEqual(['err:Writing objects: 50%', 'out:done']);
  });

  it('cancel asks Rust to kill the op by id, and is a no-op once it is over', async () => {
    const h = harness();
    const op = h.run('fetch', { root: '/r' }, () => {});
    op.cancel();
    op.cancel();
    expect(h.cancels).toEqual([101, 101]);
    h.pending[0]!.resolve(ok);
    await op.done;
    op.cancel();
    expect(h.cancels).toEqual([101, 101]);
  });

  it('a rejected invoke still marks the op settled', async () => {
    const h = harness();
    const op = h.run('pull', { root: '/r' }, () => {});
    h.pending[0]!.reject(new Error('GIT_BUSY'));
    await expect(op.done).rejects.toThrow('GIT_BUSY');
    op.cancel();
    expect(h.cancels).toEqual([]);
  });
});
