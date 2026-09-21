import { describe, expect, test } from 'vitest';

import { isMarpDocument } from '../../core/deck';
import { createDocModel, type DocModel } from '../../core/doc-model';
import type { EditorAdapter } from '../adapter';
import { createEditSwitchAdapter } from '../edit-switch';

const NOTE = '# A note';
const DECK = '---\nmarp: true\n---\n# A deck';
const host = {} as HTMLElement;

function fake(name: string, log: string[], onDetach?: (model: DocModel) => void): EditorAdapter {
  let model: DocModel | null = null;
  return {
    attach(_host, m) {
      model = m;
      log.push(`${name}:attach`);
    },
    detach() {
      log.push(`${name}:detach`);
      if (model) {
        onDetach?.(model);
      }
      model = null;
    },
    focus: () => log.push(`${name}:focus`),
  };
}

function setup(text: string, onMarkdownDetach?: (model: DocModel) => void) {
  const log: string[] = [];
  const model = createDocModel(text);
  const adapter = createEditSwitchAdapter({
    isDeck: isMarpDocument,
    markdown: () => {
      log.push('markdown:create');
      return fake('markdown', log, onMarkdownDetach);
    },
    deck: async () => {
      log.push('deck:create');
      return fake('deck', log);
    },
  });
  return { log, model, adapter };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createEditSwitchAdapter', () => {
  test('attaches the editor the content calls for, and only creates that one', async () => {
    const { log, model, adapter } = setup(DECK);
    await adapter.attach(host, model);
    expect(log).toEqual(['deck:create', 'deck:attach']);
    expect(adapter.activeKind()).toBe('deck');
    adapter.focus();
    adapter.detach();
    expect(log.slice(2)).toEqual(['deck:focus', 'deck:detach']);
    expect(adapter.activeKind()).toBeNull();
  });

  test('swaps in place when the frontmatter arrives, and back when it leaves', async () => {
    const { log, model, adapter } = setup(NOTE);
    await adapter.attach(host, model);
    model.pushText(DECK, 'programmatic');
    await settle();
    expect(log).toEqual([
      'markdown:create',
      'markdown:attach',
      'deck:create',
      'markdown:detach',
      'deck:attach',
    ]);
    model.pushText(NOTE, 'programmatic');
    await settle();
    // Instances are reused: no second create.
    expect(log.slice(5)).toEqual(['deck:detach', 'markdown:attach']);
    expect(adapter.activeKind()).toBe('markdown');
  });

  test('an ordinary edit never swaps', async () => {
    const { log, model, adapter } = setup(DECK);
    await adapter.attach(host, model);
    model.pushText(`${DECK}\n\nmore`, 'cm6');
    await settle();
    expect(log).toEqual(['deck:create', 'deck:attach']);
  });

  test('a write-back flushed by the outgoing editor’s detach does not loop', async () => {
    const { log, model, adapter } = setup(NOTE, (m) => m.pushText(`${m.getText()}\n`, 'milkdown'));
    await adapter.attach(host, model);
    model.pushText(DECK, 'programmatic');
    await settle();
    expect(log.filter((l) => l === 'deck:attach')).toHaveLength(1);
    expect(adapter.activeKind()).toBe('deck');
  });

  test('detach during a swap leaves nothing attached', async () => {
    const { log, model, adapter } = setup(NOTE);
    await adapter.attach(host, model);
    model.pushText(DECK, 'programmatic');
    adapter.detach();
    await settle();
    expect(log).not.toContain('deck:attach');
    expect(adapter.activeKind()).toBeNull();
  });
});
