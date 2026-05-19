import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';

/**
 * Inpaint editor store — brush settings + mask layer state.
 *
 * Uses zundo `temporal` middleware so mask edits can be undone via
 * `useInpaintStore.temporal.getState().undo()`.
 */
export type BrushMode = 'brush' | 'erase';

interface InpaintState {
  brushSize: number;
  brushColor: string;
  brushOpacity: number;
  brushMode: BrushMode;
  maskDataUrl: string | null;
  setBrushSize: (size: number) => void;
  setBrushColor: (color: string) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushMode: (mode: BrushMode) => void;
  setMaskDataUrl: (dataUrl: string | null) => void;
  resetMask: () => void;
}

export const useInpaintStore = create<InpaintState>()(
  temporal(
    immer((set) => ({
      brushSize: 20,
      brushColor: '#ffffff',
      brushOpacity: 1,
      brushMode: 'brush',
      maskDataUrl: null,
      setBrushSize: (size) =>
        set((s) => {
          s.brushSize = size;
        }),
      setBrushColor: (color) =>
        set((s) => {
          s.brushColor = color;
        }),
      setBrushOpacity: (opacity) =>
        set((s) => {
          s.brushOpacity = opacity;
        }),
      setBrushMode: (mode) =>
        set((s) => {
          s.brushMode = mode;
        }),
      setMaskDataUrl: (dataUrl) =>
        set((s) => {
          s.maskDataUrl = dataUrl;
        }),
      resetMask: () =>
        set((s) => {
          s.maskDataUrl = null;
        }),
    })),
    {
      // Only the mask is undoable — brush settings are config, not history.
      partialize: (state) => ({ maskDataUrl: state.maskDataUrl }),
    },
  ),
);
