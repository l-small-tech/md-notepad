/**
 * The draw-tool store: global tool/colour/width plus the palette-kind switch.
 *
 * The switch is the interesting part: the themed row (PALETTE, theme-following
 * slots) and the static row (STATIC_PALETTE, named colours that never change)
 * share a hue order, and flipping between them must carry the selection across
 * by index — "the blue pen stays a blue pen".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLOR, PALETTE, STATIC_PALETTE } from '../../../core/whiteboard/tool-settings';
import { carryColor, whiteboardStore } from '../whiteboard';

beforeEach(() => {
  whiteboardStore.setState({ paletteKind: 'themed', color: DEFAULT_COLOR });
});

describe('carryColor', () => {
  it('maps a colour to the same slot in the other palette', () => {
    expect(carryColor(PALETTE[6]!, 'static')).toBe(STATIC_PALETTE[6]);
    expect(carryColor(STATIC_PALETTE[6]!, 'themed')).toBe(PALETTE[6]);
  });

  it('leaves a colour that is not in the departing palette alone', () => {
    expect(carryColor('#123456', 'static')).toBe('#123456');
    expect(carryColor('#123456', 'themed')).toBe('#123456');
  });
});

describe('setPaletteKind', () => {
  it('switches the row and carries the selected colour across', () => {
    whiteboardStore.getState().setColor(PALETTE[4]!);
    whiteboardStore.getState().setPaletteKind('static');
    expect(whiteboardStore.getState().paletteKind).toBe('static');
    expect(whiteboardStore.getState().color).toBe(STATIC_PALETTE[4]);
    whiteboardStore.getState().setPaletteKind('themed');
    expect(whiteboardStore.getState().color).toBe(PALETTE[4]);
  });

  it('is a no-op when the kind is unchanged', () => {
    whiteboardStore.getState().setColor(PALETTE[2]!);
    whiteboardStore.getState().setPaletteKind('themed');
    expect(whiteboardStore.getState().color).toBe(PALETTE[2]);
  });
});
