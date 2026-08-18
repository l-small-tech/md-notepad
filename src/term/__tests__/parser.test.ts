import { describe, expect, it } from 'vitest';
import { Parser, type ParserActions } from '../parser';

interface Action {
  kind: string;
  args: unknown[];
}

function record(): { actions: Action[]; parser: Parser } {
  const actions: Action[] = [];
  const handler: ParserActions = {
    print: (cp) => actions.push({ kind: 'print', args: [cp] }),
    execute: (code) => actions.push({ kind: 'execute', args: [code] }),
    escDispatch: (inter, final) => actions.push({ kind: 'esc', args: [inter, final] }),
    csiDispatch: (prefix, params, inter, final) =>
      actions.push({ kind: 'csi', args: [prefix, params, inter, final] }),
    oscDispatch: (data) => actions.push({ kind: 'osc', args: [data] }),
    dcsDispatch: (prefix, params, inter, final, data) =>
      actions.push({ kind: 'dcs', args: [prefix, params, inter, final, data] }),
  };
  return { actions, parser: new Parser(handler) };
}

function feed(parser: Parser, text: string): void {
  parser.parse(new TextEncoder().encode(text));
}

describe('parser', () => {
  it('prints plain ASCII', () => {
    const { actions, parser } = record();
    feed(parser, 'hi');
    expect(actions).toEqual([
      { kind: 'print', args: [0x68] },
      { kind: 'print', args: [0x69] },
    ]);
  });

  it('executes C0 controls', () => {
    const { actions, parser } = record();
    feed(parser, 'a\r\n');
    expect(actions.map((a) => a.kind)).toEqual(['print', 'execute', 'execute']);
    expect(actions[1]!.args).toEqual([0x0d]);
    expect(actions[2]!.args).toEqual([0x0a]);
  });

  it('dispatches CSI with params', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[3;7H');
    expect(actions).toEqual([{ kind: 'csi', args: ['', [[3], [7]], '', 0x48] }]);
  });

  it('dispatches CSI with private prefix and defaults', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[?2004h\x1b[m');
    expect(actions[0]).toEqual({ kind: 'csi', args: ['?', [[2004]], '', 0x68] });
    expect(actions[1]).toEqual({ kind: 'csi', args: ['', [], '', 0x6d] });
  });

  it('keeps colon subparameters together', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[38:2:10:20:30m');
    expect(actions[0]!.args[1]).toEqual([[38, 2, 10, 20, 30]]);
  });

  it('treats empty params as zero', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[;5H');
    expect(actions[0]!.args[1]).toEqual([[0], [5]]);
  });

  it('collects CSI intermediates', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[2 q');
    expect(actions[0]).toEqual({ kind: 'csi', args: ['', [[2]], ' ', 0x71] });
  });

  it('dispatches ESC sequences with and without intermediates', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b7\x1b#8\x1b(0');
    expect(actions).toEqual([
      { kind: 'esc', args: ['', 0x37] },
      { kind: 'esc', args: ['#', 0x38] },
      { kind: 'esc', args: ['(', 0x30] },
    ]);
  });

  it('terminates OSC with BEL and with ST', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b]0;bel title\x07\x1b]0;st title\x1b\\');
    expect(actions[0]).toEqual({ kind: 'osc', args: ['0;bel title'] });
    // The ST's ESC \ also produces an escDispatch for the backslash.
    expect(actions[1]).toEqual({ kind: 'osc', args: ['0;st title'] });
  });

  it('preserves UTF-8 in OSC strings', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b]2;héllo — ✓\x07');
    expect(actions[0]!.args[0]).toBe('2;héllo — ✓');
  });

  it('dispatches DCS with payload', () => {
    const { actions, parser } = record();
    feed(parser, '\x1bP+q544e\x1b\\');
    const dcs = actions.find((a) => a.kind === 'dcs')!;
    expect(dcs.args[0]).toBe(''); // prefix
    expect(dcs.args[2]).toBe('+'); // intermediates
    expect(dcs.args[3]).toBe(0x71); // final q
    expect(dcs.args[4]).toBe('544e');
  });

  it('decodes multi-byte UTF-8 split across chunks', () => {
    const { actions, parser } = record();
    const bytes = new TextEncoder().encode('é😀中');
    for (const byte of bytes) parser.parse(Uint8Array.of(byte));
    expect(actions.map((a) => a.args[0])).toEqual([0xe9, 0x1f600, 0x4e2d]);
  });

  it('replaces invalid UTF-8 with U+FFFD and recovers', () => {
    const { actions, parser } = record();
    parser.parse(Uint8Array.of(0xff, 0x41, 0xc3, 0x28));
    // 0xff invalid; A; 0xc3 aborted by 0x28 → FFFD then '('.
    expect(actions.map((a) => a.args[0])).toEqual([0xfffd, 0x41, 0xfffd, 0x28]);
  });

  it('rejects overlong encodings', () => {
    const { actions, parser } = record();
    parser.parse(Uint8Array.of(0xe0, 0x80, 0x80)); // overlong NUL
    expect(actions).toEqual([{ kind: 'print', args: [0xfffd] }]);
  });

  it('CAN aborts a CSI sequence', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[3;\x18Az');
    expect(actions.map((a) => a.kind)).toEqual(['print', 'print']);
    expect(actions.map((a) => a.args[0])).toEqual([0x41, 0x7a]);
  });

  it('ESC mid-CSI restarts the sequence', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[12\x1b[3m');
    expect(actions).toEqual([{ kind: 'csi', args: ['', [[3]], '', 0x6d] }]);
  });

  it('splitting a sequence across chunks changes nothing', () => {
    const whole = record();
    feed(whole.parser, '\x1b[38;5;196mX');
    const split = record();
    for (const ch of '\x1b[38;5;196mX') feed(split.parser, ch);
    expect(split.actions).toEqual(whole.actions);
  });

  it('ignores SOS/PM/APC strings', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b_ignored payload\x1b\\A');
    expect(actions.filter((a) => a.kind === 'print').map((a) => a.args[0])).toEqual([0x41]);
  });

  it('executes C0 controls embedded in a CSI sequence', () => {
    const { actions, parser } = record();
    feed(parser, '\x1b[3\n;4H');
    expect(actions[0]).toEqual({ kind: 'execute', args: [0x0a] });
    expect(actions[1]).toEqual({ kind: 'csi', args: ['', [[3], [4]], '', 0x48] });
  });
});
