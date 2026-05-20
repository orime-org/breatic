import { describe, it, expect, beforeEach } from 'vitest';
import { useInpaintStore } from '@/stores/inpaint';

describe('useInpaintStore', () => {
  beforeEach(() => {
    useInpaintStore.setState({
      brushSize: 20,
      brushColor: '#ffffff',
      opacity: 1,
      tool: 'brush',
      strokes: [],
      maskDataUrl: null,
    });
    useInpaintStore.temporal.getState().clear();
  });

  it('initial brush settings', () => {
    const s = useInpaintStore.getState();
    expect(s.brushSize).toBe(20);
    expect(s.tool).toBe('brush');
    expect(s.maskDataUrl).toBeNull();
    expect(s.strokes).toEqual([]);
  });

  it('setTool flips brush <-> erase', () => {
    useInpaintStore.getState().setTool('erase');
    expect(useInpaintStore.getState().tool).toBe('erase');
  });

  it('beginStroke + appendPoint accumulate points', () => {
    useInpaintStore.getState().beginStroke({ radius: 5, alpha: 0.8 });
    useInpaintStore.getState().appendPoint({ x: 1, y: 2 });
    useInpaintStore.getState().appendPoint({ x: 3, y: 4 });
    const strokes = useInpaintStore.getState().strokes;
    expect(strokes.length).toBe(1);
    expect(strokes[0].points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(strokes[0].radius).toBe(5);
  });

  it('resetMask clears strokes + maskDataUrl', () => {
    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,XX');
    useInpaintStore.getState().beginStroke({ radius: 3, alpha: 1 });
    useInpaintStore.getState().resetMask();
    expect(useInpaintStore.getState().maskDataUrl).toBeNull();
    expect(useInpaintStore.getState().strokes).toEqual([]);
  });
});
