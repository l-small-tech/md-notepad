import { beforeEach, describe, expect, it } from 'vitest';
import { diagramViewerStore } from '../diagram-viewer';

beforeEach(() => {
  diagramViewerStore.getState().close();
});

describe('diagramViewerStore', () => {
  it('starts closed with no svg', () => {
    expect(diagramViewerStore.getState().open).toBe(false);
    expect(diagramViewerStore.getState().svg).toBeNull();
  });

  it('openWith stores the svg and opens', () => {
    diagramViewerStore.getState().openWith('<svg>a</svg>');
    expect(diagramViewerStore.getState().open).toBe(true);
    expect(diagramViewerStore.getState().svg).toBe('<svg>a</svg>');
  });

  it('close clears the svg so a stale diagram can never show', () => {
    diagramViewerStore.getState().openWith('<svg>a</svg>');
    diagramViewerStore.getState().close();
    expect(diagramViewerStore.getState().open).toBe(false);
    expect(diagramViewerStore.getState().svg).toBeNull();
  });

  it('a second openWith replaces the previous diagram', () => {
    diagramViewerStore.getState().openWith('<svg>a</svg>');
    diagramViewerStore.getState().openWith('<svg>b</svg>');
    expect(diagramViewerStore.getState().svg).toBe('<svg>b</svg>');
  });
});
