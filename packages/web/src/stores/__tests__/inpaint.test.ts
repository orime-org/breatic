import { describe, it, expect, beforeEach } from 'vitest';
import { useInpaintStore } from '../inpaint';

describe('useInpaintStore', () => {
  beforeEach(() => {
    useInpaintStore.setState({
      brushSize: 20,
      brushColor: '#ffffff',
      brushOpacity: 1,
      brushMode: 'brush',
      maskDataUrl: null,
    });
    useInpaintStore.temporal.getState().clear();
  });

  it('initial brush settings', () => {
    const s = useInpaintStore.getState();
    expect(s.brushSize).toBe(20);
    expect(s.brushMode).toBe('brush');
    expect(s.maskDataUrl).toBeNull();
  });

  it('setBrushMode flips brush <-> erase', () => {
    useInpaintStore.getState().setBrushMode('erase');
    expect(useInpaintStore.getState().brushMode).toBe('erase');
  });

  it('resetMask clears maskDataUrl', () => {
    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,XX');
    useInpaintStore.getState().resetMask();
    expect(useInpaintStore.getState().maskDataUrl).toBeNull();
  });

  it('zundo temporal exposes undo on mask edits', () => {
    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,A');
    useInpaintStore.getState().setMaskDataUrl('data:image/png;base64,B');
    // History has 2 past entries: initial null, then A.
    useInpaintStore.temporal.getState().undo();
    expect(useInpaintStore.getState().maskDataUrl).toBe(
      'data:image/png;base64,A',
    );
  });
});
