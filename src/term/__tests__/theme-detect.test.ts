/**
 * How an application asks "am I on a light terminal or a dark one?".
 *
 * Every AI TUI worth naming does this one of three ways, and the answers below
 * are what make them theme themselves correctly instead of painting a dark UI
 * onto a light console:
 *
 * - **OSC 11** (`ESC ] 11 ; ? BEL/ST`) — Claude Code (after `$COLORFGBG`),
 *   Copilot CLI, Codex (which needs OSC 10 *and* 11), Gemini CLI (polls it),
 *   Grok. The reply must be xterm's `rgb:RRRR/GGGG/BBBB` and must use the
 *   terminator the query used, because several of these read with a timeout
 *   as short as 100ms and treat a malformed or late answer as "dark".
 * - **DEC 2031 + DSR 996** — opencode, via OpenTUI, which prefers this over
 *   OSC 11 and re-themes live when an unsolicited report arrives.
 * - `$COLORFGBG` — set at spawn, see `core/terminal-palette.ts`.
 */

import { describe, expect, it } from 'vitest';
import { BEL, CSI, OSC, ST, responses, term } from './helpers';

describe('OSC 10/11/12 background detection', () => {
  it('answers with the terminator the query used', () => {
    const t = term();
    t.setDefaultColors({ background: 0x112233 });
    expect(responses(t, `${OSC}11;?${BEL}`)).toBe(`${OSC}11;rgb:1111/2222/3333${BEL}`);
    expect(responses(t, `${OSC}11;?${ST}`)).toBe(`${OSC}11;rgb:1111/2222/3333${ST}`);
  });

  it('answers OSC 10 and 12 the same way (Codex asks for 10 and 11 together)', () => {
    const t = term();
    t.setDefaultColors({ foreground: 0x102030, background: 0xf0f1f2, cursor: 0x445566 });
    expect(responses(t, `${OSC}10;?${ST}`)).toBe(`${OSC}10;rgb:1010/2020/3030${ST}`);
    expect(responses(t, `${OSC}12;?${ST}`)).toBe(`${OSC}12;rgb:4444/5555/6666${ST}`);
  });

  it('reports the CURRENT theme after a live theme switch', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    t.setDefaultColors({ background: 0xfbfdf8 });
    expect(responses(t, `${OSC}11;?${BEL}`)).toBe(`${OSC}11;rgb:fbfb/fdfd/f8f8${BEL}`);
  });

  it('OSC 4 palette queries follow the same terminator rule', () => {
    const t = term();
    t.write(`${OSC}4;1;#ff0000${BEL}`);
    expect(responses(t, `${OSC}4;1;?${ST}`)).toBe(`${OSC}4;1;rgb:ffff/0000/0000${ST}`);
  });
});

describe('DEC 2031 / DSR 996 light-dark reporting', () => {
  it('CSI ? 996 n answers 1 for dark and 2 for light', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    expect(responses(t, `${CSI}?996n`)).toBe(`${CSI}?997;1n`);
    t.setDefaultColors({ background: 0xfbfdf8 });
    expect(responses(t, `${CSI}?996n`)).toBe(`${CSI}?997;2n`);
  });

  it('the one-shot query needs no subscription', () => {
    expect(responses(term(), `${CSI}?996n`)).toBe(`${CSI}?997;1n`);
  });

  it('enabling mode 2031 is silent — it subscribes, it does not answer', () => {
    expect(responses(term(), `${CSI}?2031h`)).toBe('');
  });

  it('pushes a report to a subscriber when the theme flips light/dark', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    t.write(`${CSI}?2031h`);
    let pushed = '';
    const decoder = new TextDecoder();
    const off = t.onData((bytes) => {
      pushed += decoder.decode(bytes, { stream: true });
    });
    t.setDefaultColors({ background: 0xfbfdf8, foreground: 0x17241b });
    off();
    expect(pushed).toBe(`${CSI}?997;2n`);
  });

  it('stays quiet for a theme change that does not cross light/dark', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    t.write(`${CSI}?2031h`);
    let pushed = '';
    const off = t.onData((bytes) => {
      pushed += new TextDecoder().decode(bytes);
    });
    t.setDefaultColors({ background: 0x140f1d });
    off();
    expect(pushed).toBe('');
  });

  it('sends nothing to an application that never subscribed', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    let pushed = '';
    const off = t.onData((bytes) => {
      pushed += new TextDecoder().decode(bytes);
    });
    t.setDefaultColors({ background: 0xffffff });
    off();
    expect(pushed).toBe('');
  });

  it('unsubscribes on CSI ? 2031 l and on a full reset', () => {
    const t = term();
    t.setDefaultColors({ background: 0x0b0f14 });
    t.write(`${CSI}?2031h${CSI}?2031l`);
    expect(responses(t, `${CSI}?2031$p`)).toBe(`${CSI}?2031;2$y`);
    t.write(`${CSI}?2031h`);
    expect(responses(t, `${CSI}?2031$p`)).toBe(`${CSI}?2031;1$y`);
    t.write('\x1bc');
    expect(responses(t, `${CSI}?2031$p`)).toBe(`${CSI}?2031;2$y`);
  });
});
