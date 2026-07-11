/**
 * @vitest-environment jsdom
 *
 * Pins the TS half of the IPC error contract using the official Tauri mock
 * (`mockIPC`). This is the pattern for testing anything that calls `ipc.*`
 * without a running Tauri app.
 */
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, test } from 'vitest';
import { IpcError, ipc } from '../commands';

afterEach(() => {
  clearMocks();
});

describe('ipc wrappers', () => {
  test('forwards command name and camelCase args, returns the payload', async () => {
    const seen: Array<{ cmd: string; args: unknown }> = [];
    mockIPC((cmd, args) => {
      seen.push({ cmd, args });
      if (cmd === 'read_text_file') {
        return { text: '# hi', mtimeMs: 1234 };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const result = await ipc.readTextFile('C:/notes/hi.md');
    expect(result).toEqual({ text: '# hi', mtimeMs: 1234 });
    expect(seen).toEqual([{ cmd: 'read_text_file', args: { path: 'C:/notes/hi.md' } }]);
  });

  test('maps structured Rust errors to typed IpcError', async () => {
    mockIPC(() => {
      // Exactly what FsError::Exists serializes to (src-tauri/src/commands/fs.rs).
      throw { code: 'EXISTS', message: 'destination already exists: b.md' };
    });

    const error = await ipc.renamePath('a.md', 'b.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe('EXISTS');
    expect((error as IpcError).message).toContain('b.md');
  });

  test('unshaped errors degrade to code IO instead of leaking raw values', async () => {
    mockIPC(() => {
      throw 'some plugin string error';
    });

    const error = await ipc.statPath('x.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe('IO');
    expect((error as IpcError).message).toContain('some plugin string error');
  });
});
