// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { parseAdjustValue, type AdjustValue } from '@breatic/shared';
import { isModelTool, miniToolById } from '@breatic/shared/mini-tools';

import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { prepareCropSource } from '@web/spaces/canvas/focus/crop-export';
import type { CropSourceEl } from '@web/spaces/canvas/focus/crop-source';
import { drawAdjusted } from '@web/spaces/canvas/mini-tool/adjust-export';

interface NodeAdjustLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The picture adjust's result, drawn over the node's picture while that tool's
 * panel is open on it (inner#1303 §6.1). It redraws at most once a frame as
 * the sliders move, at the size the picture is shown and never past its own
 * pixels.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The layer, or null when no picture adjust is open on this node.
 */
export function NodeAdjustLayer({ nodeId, wrapper }: NodeAdjustLayerProps): React.JSX.Element | null {
  const draft = useCanvasSession(miniToolOpenOn(nodeId));
  const spec = draft === null ? undefined : miniToolById(draft.toolId);
  const param =
    spec === undefined || isModelTool(spec) || spec.source !== 'image'
      ? undefined
      : spec.params.find((p) => p.kind === 'adjust');
  const geometry = useMediaGeometry(wrapper, param !== undefined);
  const raw = param === undefined ? undefined : draft?.params[param.key];
  const value = React.useMemo(() => parseAdjustValue(raw), [raw]);
  const canvas = React.useRef<HTMLCanvasElement>(null);
  // The latest picture, size and value waiting for the next frame, and
  // whether a frame is asked for.
  const pending = React.useRef<{ el: CropSourceEl; size: { width: number; height: number }; value: AdjustValue } | null>(null);
  const frame = React.useRef<number | null>(null);

  const box = geometry?.box;
  const natural = geometry?.natural ?? null;
  // The node's own picture is not CORS-loaded and WebGL refuses it, so the
  // preview draws from a copy that is, loaded once per picture.
  const src = geometry?.src ?? null;
  const [el, setEl] = React.useState<HTMLImageElement | HTMLVideoElement | undefined>(undefined);
  React.useEffect(() => {
    if (param === undefined || src === null) return undefined;
    let live = true;
    prepareCropSource({ url: src, timeSeconds: null }).then(
      (loaded) => {
        if (live) setEl(loaded);
      },
      () => {
        // The preview stays the picture as it is; the export loads it again
        // and says so if it fails.
      },
    );
    return () => {
      live = false;
      setEl(undefined);
    };
  }, [param, src]);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const width = box === undefined ? 0 : Math.max(1, Math.round(Math.min(box.width * dpr, natural?.width ?? Infinity)));
  const height = box === undefined ? 0 : Math.max(1, Math.round((width * box.height) / box.width));

  React.useEffect(() => {
    if (param === undefined || el === undefined || width === 0) return;
    pending.current = { el, size: { width, height }, value };
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      const target = canvas.current;
      if (next === null || target === null) return;
      void drawAdjusted(next.el, next.size, next.value, target);
    });
  }, [param, el, width, height, value]);

  React.useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  if (param === undefined || geometry === null) return null;
  return (
    <canvas
      ref={canvas}
      data-testid='mini-tool-adjust-layer'
      className='pointer-events-none absolute bg-card'
      style={{ left: geometry.at.x, top: geometry.at.y, width: geometry.box.width, height: geometry.box.height }}
    />
  );
}
