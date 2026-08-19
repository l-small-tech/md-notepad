/**
 * The draw-tool store: global tool/colour/width plus the palette-kind switch.
 *
 * The switch is the interesting part: flipping between the themed row
 * (PALETTE, theme-following slots) and the static row (STATIC_PALETTE, named
 * colours that never change) must carry the selection across by index — the
 * Nth marker stays the Nth marker.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COLOR, PALETTE, STATIC_PALETTE } from '../../../core/whiteboard/tool-settings';
import { fingerDrawsEnabled } from '../../../core/whiteboard/input';
import { carryColor, drawStateFor, whiteboardStore } from '../whiteboard';

beforeEach(() => {
  whiteboardStore.setState({
    paletteKind: 'themed',
    color: DEFAULT_COLOR,
    fingerDraws: null,
    penSeen: false,
    viewByTab: {},
    byTab: {},
  });
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
});

describe('touch policy (phase 3)', () => {
  it('starts with no preference and no pen, so a finger draws', () => {
    const s = whiteboardStore.getState();
    expect(fingerDrawsEnabled(s.fingerDraws, s.penSeen)).toBe(true);
  });

  it('stops fingers drawing once a pen has been seen, unless told otherwise', () => {
    whiteboardStore.getState().notePenSeen();
    let s = whiteboardStore.getState();
    expect(s.penSeen).toBe(true);
    expect(fingerDrawsEnabled(s.fingerDraws, s.penSeen)).toBe(false);

    whiteboardStore.getState().setFingerDraws(true);
    s = whiteboardStore.getState();
    expect(fingerDrawsEnabled(s.fingerDraws, s.penSeen)).toBe(true);
  });
});

describe('per-tab state', () => {
  const VIEW = { scale: 2, x: 10, y: -5 };

  it('keeps a viewport per tab so switching tabs keeps your place', () => {
    whiteboardStore.getState().saveView('t1', VIEW);
    whiteboardStore.getState().saveView('t2', { scale: 1, x: 0, y: 0 });
    expect(whiteboardStore.getState().viewByTab.t1).toEqual(VIEW);
  });

  it('forgets everything about a tab when it closes', () => {
    whiteboardStore.getState().saveView('t1', VIEW);
    whiteboardStore.getState().reportTabState('t1', {
      canUndo: true,
      canRedo: false,
      layersOpen: false,
      activeLayerName: 'Layer 1',
      selectionCount: 3,
    });
    whiteboardStore.getState().clearTab('t1');
    expect(whiteboardStore.getState().viewByTab.t1).toBeUndefined();
    expect(whiteboardStore.getState().byTab.t1).toBeUndefined();
  });

  it('reports an idle state for a tab it knows nothing about', () => {
    expect(drawStateFor('nope')).toMatchObject({ canUndo: false, selectionCount: 0 });
    expect(drawStateFor(null)).toMatchObject({ canUndo: false });
  });
});
