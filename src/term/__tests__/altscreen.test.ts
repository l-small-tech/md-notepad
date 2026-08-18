import { describe, expect, it } from 'vitest';
import { CSI, feed, term } from './helpers';

describe('alternate screen', () => {
  it('1049 switches to a cleared alt screen and back, restoring cursor', () => {
    const t = term({ cols: 5, rows: 3 });
    feed(t, 'main');
    expect(t.cursor.x).toBe(4);
    t.write(`${CSI}?1049h`);
    expect(t.modes().altScreen).toBe(true);
    expect(t.serialize()).toEqual(['', '', '']);
    feed(t, `${CSI}HALT`);
    expect(t.serialize()[0]).toBe('ALT');
    t.write(`${CSI}?1049l`);
    expect(t.modes().altScreen).toBe(false);
    expect(t.serialize()[0]).toBe('main');
    expect(t.cursor.x).toBe(4);
  });

  it('re-entering 1049 clears previous alt content', () => {
    const t = term({ cols: 5, rows: 2 });
    t.write(`${CSI}?1049hALT${CSI}?1049l${CSI}?1049h`);
    expect(t.serialize()).toEqual(['', '']);
  });

  it('mode 47 swaps without clearing', () => {
    const t = term({ cols: 5, rows: 2 });
    t.write(`${CSI}?47hone${CSI}?47l${CSI}?47h`);
    expect(t.serialize()[0]).toBe('one');
  });

  it('no scrollback accumulates while on the alt screen', () => {
    const t = term({ cols: 3, rows: 2 });
    t.write(`${CSI}?1049h`);
    feed(t, 'a\r\nb\r\nc\r\nd');
    expect(t.scrollbackLength).toBe(0);
    t.write(`${CSI}?1049l`);
    expect(t.modes().altScreen).toBe(false);
  });

  it('viewport snaps to bottom and stays there on the alt screen', () => {
    const t = term({ cols: 3, rows: 2 });
    feed(t, 'a\r\nb\r\nc\r\n');
    t.scrollViewport(10);
    expect(t.viewportOffset).toBeGreaterThan(0);
    t.write(`${CSI}?1049h`);
    expect(t.viewportOffset).toBe(0);
    t.scrollViewport(5);
    expect(t.viewportOffset).toBe(0);
  });
});
