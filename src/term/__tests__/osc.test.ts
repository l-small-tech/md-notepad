import { describe, expect, it } from 'vitest';
import { Terminal } from '../terminal';
import { BEL, CSI, OSC, ST, feed, responses, term } from './helpers';

describe('OSC', () => {
  it('0 and 2 set the window title and fire the event', () => {
    const t = term();
    const titles: string[] = [];
    t.setHandlers({ title: (title) => titles.push(title) });
    t.write(`${OSC}0;First${BEL}${OSC}2;Second${ST}`);
    expect(titles).toEqual(['First', 'Second']);
    expect(t.title).toBe('Second');
  });

  it('title stack push/pop via XTWINOPS 22/23', () => {
    const t = term();
    t.write(`${OSC}0;Original${BEL}${CSI}22t${OSC}0;Temporary${BEL}${CSI}23t`);
    expect(t.title).toBe('Original');
  });

  it('8 assigns hyperlink ids to cells and ends on empty uri', () => {
    const t = term();
    t.write(`${OSC}8;;https://example.com${ST}link${OSC}8;;${ST}plain`);
    const linked = t.row(0).getCell(0);
    expect(linked.extended?.linkId).toBeTruthy();
    expect(t.hyperlink(linked.extended!.linkId)?.uri).toBe('https://example.com');
    const plain = t.row(0).getCell(4);
    expect(plain.extended).toBeNull();
  });

  it('8 with the same id param joins to one link id', () => {
    const t = term();
    t.write(`${OSC}8;id=x;https://a${ST}a${OSC}8;;${ST}${OSC}8;id=x;https://a${ST}b`);
    const first = t.row(0).getCell(0).extended!.linkId;
    const second = t.row(0).getCell(1).extended!.linkId;
    expect(first).toBe(second);
  });

  it('52 write fires the clipboard event; query is ignored', () => {
    const t = term();
    const payloads: string[] = [];
    t.setHandlers({ clipboard: (data) => payloads.push(data) });
    t.write(`${OSC}52;c;aGVsbG8=${BEL}`);
    expect(payloads).toEqual(['aGVsbG8=']);
    expect(responses(t, `${OSC}52;c;?${BEL}`)).toBe('');
  });

  it('7 reports the cwd', () => {
    const t = term();
    const urls: string[] = [];
    t.setHandlers({ cwd: (url) => urls.push(url) });
    t.write(`${OSC}7;file://host/home/user${BEL}`);
    expect(urls).toEqual(['file://host/home/user']);
  });

  it('11 query reports the background color', () => {
    const t = term();
    t.setDefaultColors({ background: 0x112233 });
    expect(responses(t, `${OSC}11;?${BEL}`)).toBe(`${OSC}11;rgb:1111/2222/3333${BEL}`);
  });

  it('10 set then query round-trips', () => {
    const t = term();
    t.write(`${OSC}10;#aabbcc${BEL}`);
    expect(responses(t, `${OSC}10;?${BEL}`)).toBe(`${OSC}10;rgb:aaaa/bbbb/cccc${BEL}`);
  });

  it('4 sets and queries a palette entry', () => {
    const t = term();
    t.write(`${OSC}4;1;rgb:ff/00/00${BEL}`);
    expect(t.paletteColor(1)).toBe(0xff0000);
    expect(responses(t, `${OSC}4;1;?${BEL}`)).toBe(`${OSC}4;1;rgb:ffff/0000/0000${BEL}`);
    t.write(`${OSC}104;1${BEL}`);
    expect(t.paletteColor(1)).toBe(0xcd0000);
  });

  it('133 marks are recorded with exit codes', () => {
    const t = term({ cols: 10, rows: 5 });
    const kinds: string[] = [];
    t.setHandlers({ mark: (mark) => kinds.push(mark.kind) });
    t.write(`${OSC}133;A${BEL}$ ls\r\n${OSC}133;C${BEL}out\r\n${OSC}133;D;0${BEL}`);
    expect(kinds).toEqual(['A', 'C', 'D']);
    expect(t.marks[2]).toMatchObject({ kind: 'D', exitCode: 0, absoluteLine: 2 });
  });

  it('unknown OSC ids are ignored safely', () => {
    const t = term();
    feed(t, `${OSC}9999;whatever${BEL}ok`);
    expect(t.serialize()[0]).toBe('ok');
  });
});

describe('reports', () => {
  it('DA1 claims VT220-class', () => {
    expect(responses(term(), `${CSI}c`)).toBe(`${CSI}?62;22c`);
  });

  it('DA2', () => {
    expect(responses(term(), `${CSI}>c`)).toBe(`${CSI}>1;10;0c`);
  });

  it('DSR 5 reports OK', () => {
    expect(responses(term(), `${CSI}5n`)).toBe(`${CSI}0n`);
  });

  it('DSR 6 reports the cursor position', () => {
    const t = term();
    t.write(`${CSI}3;4H`);
    expect(responses(t, `${CSI}6n`)).toBe(`${CSI}3;4R`);
  });

  it('DSR 6 respects origin mode', () => {
    const t = term({ rows: 10 });
    t.write(`${CSI}3;8r${CSI}?6h${CSI}2;2H`);
    expect(responses(t, `${CSI}6n`)).toBe(`${CSI}2;2R`);
  });

  it('DECRQM reports set, reset and unknown', () => {
    const t = term();
    t.write(`${CSI}?2004h`);
    expect(responses(t, `${CSI}?2004$p`)).toBe(`${CSI}?2004;1$y`);
    expect(responses(t, `${CSI}?2026$p`)).toBe(`${CSI}?2026;2$y`);
    expect(responses(t, `${CSI}?31337$p`)).toBe(`${CSI}?31337;0$y`);
  });

  it('XTVERSION answers with a DCS string', () => {
    expect(responses(term(), `${CSI}>0q`)).toBe(`\x1bP>|smooth-terminal 0.1.0${ST}`);
  });

  it('DECSCUSR fires the cursor style event', () => {
    const t = term();
    const seen: [string, boolean][] = [];
    t.setHandlers({ cursorStyle: (style, blink) => seen.push([style, blink]) });
    t.write(`${CSI}5 q${CSI}2 q`);
    expect(seen).toEqual([
      ['bar', true],
      ['block', false],
    ]);
  });

  it('bell fires the event', () => {
    const t = term();
    let rang = 0;
    t.setHandlers({ bell: () => rang++ });
    t.write('a\x07b');
    expect(rang).toBe(1);
    expect(t.serialize()[0]).toBe('ab');
  });
});

describe('modes for the input layer', () => {
  it('tracks keyboard, paste, mouse and sync modes', () => {
    const t = term();
    t.write(`${CSI}?1h${CSI}?2004h${CSI}?1002h${CSI}?1006h${CSI}?1004h${CSI}?2026h\x1b=`);
    expect(t.modes()).toMatchObject({
      applicationCursorKeys: true,
      bracketedPaste: true,
      mouseTracking: 'drag',
      mouseEncoding: 'sgr',
      focusReporting: true,
      synchronizedOutput: true,
      applicationKeypad: true,
    });
    expect(t.synchronized).toBe(true);
    t.write(`${CSI}?2026l${CSI}?1002l\x1b>`);
    expect(t.modes()).toMatchObject({
      synchronizedOutput: false,
      mouseTracking: 'none',
      applicationKeypad: false,
    });
  });

  it('drops a synchronized-output batch the application never closed', () => {
    const t = term();
    t.write(`${CSI}?2026h`);
    expect(t.synchronized).toBe(true);

    t.abortSynchronizedOutput();
    expect(t.synchronized).toBe(false);
    expect(t.modes()).toMatchObject({ synchronizedOutput: false });

    // A late `l` for the dropped batch is a no-op, not a second toggle.
    t.write(`${CSI}?2026l`);
    expect(t.synchronized).toBe(false);
  });

  it('DECTCEM hides and shows the cursor', () => {
    const t = term();
    t.write(`${CSI}?25l`);
    expect(t.cursor.visible).toBe(false);
    t.write(`${CSI}?25h`);
    expect(t.cursor.visible).toBe(true);
  });

  it('RIS restores a pristine terminal', () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.write(`${CSI}31mhi${CSI}?25l${CSI}?1049h\x1bc`);
    expect(t.serialize()).toEqual(['', '']);
    expect(t.cursor).toMatchObject({ x: 0, y: 0, visible: true });
    expect(t.modes().altScreen).toBe(false);
    t.write('x');
    expect(t.row(0).getCell(0).fg).toBe(0);
  });
});
