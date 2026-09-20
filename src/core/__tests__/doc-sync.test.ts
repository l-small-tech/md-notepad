import { describe, expect, it, vi } from 'vitest';
import { createDocModel } from '../doc-model';
import { createDocSyncHub, type DocSyncHub, type DocSyncMessage } from '../doc-sync';

const KEY = 'c:/notes/a.md';

function peer(hub: DocSyncHub, id: string, text: string, key = KEY) {
  const model = createDocModel(text);
  const onSaved = vi.fn();
  const detach = hub.attach({ id, key, model, onSaved });
  return { model, onSaved, detach };
}

/** Two hubs wired back to back, like two windows on the event bus. */
function twoWindows() {
  const wire: { a: DocSyncMessage[]; b: DocSyncMessage[] } = { a: [], b: [] };
  // eslint-disable-next-line prefer-const
  let b: DocSyncHub;
  const a: DocSyncHub = createDocSyncHub({
    send: (m) => {
      wire.a.push(m);
      b.receive(m);
    },
  });
  b = createDocSyncHub({
    send: (m) => {
      wire.b.push(m);
      a.receive(m);
    },
  });
  return { a, b, wire };
}

describe('doc sync hub', () => {
  it('mirrors an edit into sibling tabs of the same window', () => {
    const hub = createDocSyncHub({ send: () => {} });
    const one = peer(hub, '1', 'hello');
    const two = peer(hub, '2', 'hello');
    const other = peer(hub, '3', 'hello', 'c:/notes/b.md');
    one.model.pushText('hello world', 'cm6');
    expect(two.model.getText()).toBe('hello world');
    expect(other.model.getText()).toBe('hello');
    two.model.pushText('back', 'cm6');
    expect(one.model.getText()).toBe('back');
  });

  it('stops mirroring once detached', () => {
    const hub = createDocSyncHub({ send: () => {} });
    const one = peer(hub, '1', 'x');
    const two = peer(hub, '2', 'x');
    two.detach();
    one.model.pushText('y', 'cm6');
    expect(two.model.getText()).toBe('x');
    two.model.pushText('z', 'cm6');
    expect(one.model.getText()).toBe('y');
  });

  it('only broadcasts text for files another window holds', () => {
    const sent: DocSyncMessage[] = [];
    const hub = createDocSyncHub({ send: (m) => sent.push(m) });
    const one = peer(hub, '1', 'x');
    one.model.pushText('y', 'cm6');
    expect(sent.map((m) => m.type)).toEqual(['hello']);
    hub.receive({ type: 'here', key: KEY });
    one.model.pushText('z', 'cm6');
    expect(sent.at(-1)).toEqual({ type: 'text', key: KEY, text: 'z' });
  });

  it('syncs edits between windows in both directions without echoing', () => {
    const { a, b, wire } = twoWindows();
    const left = peer(a, '1', 'doc');
    const right = peer(b, '2', 'doc');
    left.model.pushText('doc!', 'cm6');
    expect(right.model.getText()).toBe('doc!');
    right.model.pushText('doc!?', 'cm6');
    expect(left.model.getText()).toBe('doc!?');
    expect(wire.a.filter((m) => m.type === 'text')).toHaveLength(1);
    expect(wire.b.filter((m) => m.type === 'text')).toHaveLength(1);
  });

  it('hands unsaved edits to a newcomer in another window', () => {
    const { a, b } = twoWindows();
    const left = peer(a, '1', 'disk');
    left.model.pushText('disk + unsaved', 'cm6');
    const right = peer(b, '2', 'disk');
    expect(right.model.getText()).toBe('disk + unsaved');
    expect(right.model.isDirty('file')).toBe(true);
  });

  it('leaves a newcomer alone when the holder is clean', () => {
    const { a, b } = twoWindows();
    peer(a, '1', 'old disk');
    const right = peer(b, '2', 'newer disk');
    expect(right.model.getText()).toBe('newer disk');
  });

  it('announces a save to local and remote mirrors, never the saver', () => {
    const { a, b } = twoWindows();
    const saver = peer(a, '1', 'x');
    const sibling = peer(a, '2', 'x');
    const remote = peer(b, '3', 'x');
    a.notifySaved('1', 'x', 42);
    expect(saver.onSaved).not.toHaveBeenCalled();
    expect(sibling.onSaved).toHaveBeenCalledWith('x', 42);
    expect(remote.onSaved).toHaveBeenCalledWith('x', 42);
  });

  it('knows texts a mirror held moments ago, per file, briefly', () => {
    let clock = 1000;
    const hub = createDocSyncHub({ send: () => {}, now: () => clock });
    peer(hub, '1', 'one');
    hub.receive({ type: 'text', key: KEY, text: 'two' });
    expect(hub.knows(KEY, 'two')).toBe(true);
    expect(hub.knows(KEY, 'one')).toBe(false); // never came from a mirror
    expect(hub.knows('c:/other.md', 'two')).toBe(false);
    clock += 6000;
    expect(hub.knows(KEY, 'two')).toBe(false);
  });

  it('never remembers the texts of an unmirrored file', () => {
    const hub = createDocSyncHub({ send: () => {} });
    const one = peer(hub, '1', 'one');
    one.model.pushText('two', 'cm6');
    expect(hub.knows(KEY, 'two')).toBe(false);
  });

  it('finds a sibling to seed a new mirror from', () => {
    const hub = createDocSyncHub({ send: () => {} });
    peer(hub, '1', 'x');
    expect(hub.siblingOf(KEY)?.id).toBe('1');
    expect(hub.siblingOf(KEY, '1')).toBeUndefined();
  });
});
