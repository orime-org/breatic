// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { temporal } from 'zundo';

import type {
  InpaintPoint,
  InpaintStroke,
} from '@web/spaces/canvas/inpaint/types';

/**
 * Inpaint editor store — brush settings + stroke history + exported
 * mask. Strokes are the source of truth (so undo / redo work per-stroke
 * without re-painting the full mask); `maskDataUrl` is set by the
 * mask-export step before the inpaint request is dispatched.
 *
 * Uses zundo `temporal` middleware partialized over `strokes` so brush
 * settings stay un-undoable while stroke edits roll back cleanly.
 */
export type BrushMode = 'brush' | 'erase';

interface InpaintState {
  // Brush settings (config, NOT undoable)
  brushSize: number;
  brushColor: string;
  opacity: number;
  tool: BrushMode;
  // History (undoable)
  strokes: InpaintStroke[];
  // Export
  maskDataUrl: string | null;

  setBrushSize: (size: number) => void;
  setBrushColor: (color: string) => void;
  setOpacity: (opacity: number) => void;
  setTool: (tool: BrushMode) => void;

  beginStroke: (init: { radius: number; alpha: number }) => void;
  appendPoint: (point: InpaintPoint) => void;
  endStroke: () => void;
  clearStrokes: () => void;

  setMaskDataUrl: (dataUrl: string | null) => void;
  resetMask: () => void;
  /**
   * Reset the per-project inpaint session (strokes + mask) on project change
   * (#1771). Brush PREFERENCES (size / color / opacity / tool) are kept. The
   * zundo undo history is separate — the `resetProjectUiStores` helper clears
   * `temporal` alongside this so a fresh entry can't undo back into old strokes.
   */
  reset: () => void;
}

let strokeSeq = 0;
/**
 * Generate a process-unique stroke id from a monotonic counter.
 * @returns A new `stroke-<n>` id that is unique within the session.
 */
function nextStrokeId(): string {
  strokeSeq += 1;
  return `stroke-${strokeSeq}`;
}

export const useInpaintStore = create<InpaintState>()(
  temporal(
    immer((set) => ({
      brushSize: 20,
      brushColor: '#ffffff',
      opacity: 1,
      tool: 'brush',
      strokes: [],
      maskDataUrl: null,

      setBrushSize: (size) =>
        set((s) => {
          s.brushSize = size;
        }),
      setBrushColor: (color) =>
        set((s) => {
          s.brushColor = color;
        }),
      setOpacity: (opacity) =>
        set((s) => {
          s.opacity = opacity;
        }),
      setTool: (tool) =>
        set((s) => {
          s.tool = tool;
        }),

      beginStroke: (init) =>
        set((s) => {
          s.strokes.push({
            id: nextStrokeId(),
            radius: init.radius,
            alpha: init.alpha,
            points: [],
          });
        }),
      appendPoint: (point) =>
        set((s) => {
          const stroke = s.strokes[s.strokes.length - 1];
          if (!stroke) return;
          stroke.points = [...stroke.points, point];
        }),
      endStroke: () => {
        // Stroke is already appended; this hook exists so callers can
        // mark a brush gesture complete without further mutation.
      },
      clearStrokes: () =>
        set((s) => {
          s.strokes = [];
        }),

      setMaskDataUrl: (dataUrl) =>
        set((s) => {
          s.maskDataUrl = dataUrl;
        }),
      resetMask: () =>
        set((s) => {
          s.maskDataUrl = null;
          s.strokes = [];
        }),
      reset: () =>
        set((s) => {
          s.strokes = [];
          s.maskDataUrl = null;
          // Brush prefs (size / color / opacity / tool) are kept.
        }),
    })),
    {
      partialize: (state) => ({ strokes: state.strokes }),
    },
  ),
);
