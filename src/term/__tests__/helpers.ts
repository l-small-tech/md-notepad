import { Terminal, type TerminalOptions } from '../terminal';

export const ESC = '\x1b';
export const CSI = '\x1b[';
export const OSC = '\x1b]';
export const ST = '\x1b\\';
export const BEL = '\x07';

export function term(options: Partial<TerminalOptions> = {}): Terminal {
  return new Terminal({ cols: 10, rows: 5, ...options });
}

/** Feed `data` and return the screen as trimmed lines. */
export function feed(t: Terminal, data: string): string[] {
  t.write(data);
  return t.serialize();
}

/** Collect response bytes the terminal emits while `data` is processed. */
export function responses(t: Terminal, data: string): string {
  let out = '';
  const decoder = new TextDecoder();
  const off = t.onData((bytes) => {
    out += decoder.decode(bytes, { stream: true });
  });
  t.write(data);
  off();
  return out;
}
