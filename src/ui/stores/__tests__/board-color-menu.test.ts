import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardColorMenuStore,
  refreshImagesEverywhere,
  registerImageRefresher,
  unregisterImageRefresher,
} from '../board-color-menu';

beforeEach(() => {
  boardColorMenuStore.getState().close();
});

describe('boardColorMenuStore', () => {
  it('starts closed', () => {
    const s = boardColorMenuStore.getState();
    expect(s.open).toBe(false);
    expect(s.path).toBeNull();
    expect(s.docPaths).toEqual([]);
  });

  it('openFor records the click and close forgets the board', () => {
    boardColorMenuStore.getState().openFor({
      path: 'C:/a.svg',
      mode: 'fixed',
      docPaths: ['C:/a.svg', 'C:/b.svg'],
      x: 10,
      y: 20,
    });
    const s = boardColorMenuStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe('C:/a.svg');
    expect(s.mode).toBe('fixed');
    expect(s.docPaths).toEqual(['C:/a.svg', 'C:/b.svg']);
    expect([s.x, s.y]).toEqual([10, 20]);
    boardColorMenuStore.getState().close();
    expect(boardColorMenuStore.getState().open).toBe(false);
    expect(boardColorMenuStore.getState().path).toBeNull();
    expect(boardColorMenuStore.getState().docPaths).toEqual([]);
  });
});

describe('image refresh registry', () => {
  it('fans a refresh out to every registered view, and forgets unregistered ones', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerImageRefresher('t1:preview', a);
    registerImageRefresher('t1:rich', b);
    refreshImagesEverywhere(['C:/a.svg']);
    expect(a).toHaveBeenCalledWith(['C:/a.svg']);
    expect(b).toHaveBeenCalledWith(['C:/a.svg']);
    unregisterImageRefresher('t1:rich');
    refreshImagesEverywhere(['C:/b.svg']);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
    unregisterImageRefresher('t1:preview');
  });

  it('re-registering a key replaces the previous hook', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerImageRefresher('t2:preview', first);
    registerImageRefresher('t2:preview', second);
    refreshImagesEverywhere(['x']);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    unregisterImageRefresher('t2:preview');
  });
});
