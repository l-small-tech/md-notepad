import { describe, expect, it } from 'vitest';
import { parseStatuses, promptSections } from '../../core/prompt-status';
import { createPromptStatus } from '../prompt-status';

function setup(files: Record<string, string>) {
  let clipboard = '';
  const api = createPromptStatus({
    roots: () => ['C:/ws', 'C:/plain'],
    read: async (p) => files[p] ?? null,
    write: async (p, t) => {
      files[p] = t;
    },
    copy: async (t) => {
      clipboard = t;
    },
    now: () => new Date(2026, 8, 20, 9, 5),
  });
  return { api, files, clip: () => clipboard };
}

const NOTE = '# Plan\n\n## Build it\ndo things\n';

describe('prompt status store', () => {
  it('tracks only workspaces that have a STATUSES.md', async () => {
    const { api } = setup({ 'C:/ws/STATUSES.md': '| a.md | done | t | s |' });
    await api.refresh();
    expect(Object.keys(api.store.getState().byRoot)).toEqual(['c:/ws']);
    expect(api.locate(['C:', 'ws', 'prompts', 'a.md'].join(String.fromCharCode(92)))?.rel).toBe(
      'prompts/a.md',
    );
    expect(api.locate('C:/plain/a.md')).toBeNull();
  });

  it('copies a section and queues it, keeping rows written meanwhile', async () => {
    const { api, files, clip } = setup({ 'C:/ws/STATUSES.md': '' });
    await api.refresh();
    files['C:/ws/STATUSES.md'] = '| other.md | running | t | agent wrote this |';
    const section = promptSections(NOTE)[1]!;
    expect(await api.copyAsPrompt('C:/ws/prompts/plan.md', NOTE, section)).toBe(true);
    expect(clip()).toBe('## Build it\ndo things\n\nPrompt-id: prompts/plan.md#build-it\n');
    expect(parseStatuses(files['C:/ws/STATUSES.md']!)).toEqual([
      { key: 'other.md', status: 'running', updated: 't', summary: 'agent wrote this' },
      {
        key: 'prompts/plan.md#build-it',
        status: 'queued',
        updated: '2026-09-20 09:05',
        summary: '',
      },
    ]);
    expect(api.store.getState().byRoot['c:/ws']!.rows).toHaveLength(2);
  });

  it('does not re-queue a prompt an agent is working on', async () => {
    const { api, files } = setup({ 'C:/ws/STATUSES.md': '| plan.md | running | t | busy |' });
    await api.refresh();
    const before = files['C:/ws/STATUSES.md'];
    await api.copyAsPrompt('C:/ws/plan.md', NOTE, null);
    expect(files['C:/ws/STATUSES.md']).toBe(before);
  });

  it('refuses outside a tracked workspace', async () => {
    const { api } = setup({});
    await api.refresh();
    expect(await api.copyAsPrompt('C:/plain/a.md', NOTE, null)).toBe(false);
  });
});
