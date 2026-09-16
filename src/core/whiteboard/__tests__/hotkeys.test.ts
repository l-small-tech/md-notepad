import { describe, expect, it } from 'vitest';
import { hotkeyForTool, SHAPE_TOOLS, TOOL_HOTKEYS, toolForHotkey } from '../tool-settings';

describe('tool hotkeys', () => {
  it('maps the conventional letters, either case', () => {
    expect(toolForHotkey('v')).toBe('select');
    expect(toolForHotkey('P')).toBe('pen');
    expect(toolForHotkey('h')).toBe('highlighter');
    expect(toolForHotkey('e')).toBe('eraser');
    expect(toolForHotkey('t')).toBe('text');
    expect(toolForHotkey('r')).toBe('rect');
    expect(toolForHotkey('o')).toBe('ellipse');
    expect(toolForHotkey('l')).toBe('line');
    expect(toolForHotkey('a')).toBe('arrow');
  });

  it('leaves G for the grid and ignores anything that is not a single key', () => {
    expect(toolForHotkey('g')).toBeNull();
    expect(toolForHotkey('Enter')).toBeNull();
    expect(toolForHotkey('ArrowLeft')).toBeNull();
    expect(toolForHotkey('')).toBeNull();
  });

  it('reads back the letter for a tool', () => {
    expect(hotkeyForTool('select')).toBe('V');
    expect(hotkeyForTool('arrow')).toBe('A');
    expect(hotkeyForTool('diamond')).toBeNull();
  });

  it('only names tools that exist', () => {
    const tools = new Set(['select', 'pen', 'highlighter', 'eraser', 'text', ...SHAPE_TOOLS]);
    for (const tool of Object.values(TOOL_HOTKEYS)) {
      expect(tools.has(tool)).toBe(true);
    }
  });
});
