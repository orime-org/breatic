// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { parseAdjustValue, type AdjustValue } from '@breatic/shared';
import { isModelTool, miniToolById } from '@breatic/shared/mini-tools';

import { useCanvasSession } from '@web/spaces/canvas/canvas-context';
import { miniToolOpenOn } from '@web/stores/canvas-session';
import { useMediaGeometry } from '@web/spaces/canvas/crop/media-geometry';
import { prepareCropSource } from '@web/spaces/canvas/focus/crop-export';
import type { CropSourceEl } from '@web/spaces/canvas/focus/crop-source';
import { cn } from '@web/lib/utils';
import { drawAdjustedPreview, releasePreviewBackend } from '@web/spaces/canvas/mini-tool/adjust-export';

interface NodeAdjustLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /** The node's outer positioned wrapper; see `NodeCropLayer`. */
  wrapper: HTMLElement | null;
}

/**
 * The picture adjust's result, drawn over the node's picture while that tool's
 * panel is open on it (inner#1303 §6.1). It redraws at most once a frame as
 * the sliders move, at the source shrunk by the power of two `previewFrame`
 * picks for the size the picture is shown, and is stretched over the picture.
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
  // The layer stays invisible until a frame is drawn on it, so the node's
  // picture shows while the copy loads, and for good if it never does.
  const [drawn, setDrawn] = React.useState(false);
  // The source pixels the last draw spans; past the picture's own when the
  // preview is drawn at a power of two that does not divide it.
  const [spans, setSpans] = React.useState<{ width: number; height: number } | null>(null);
  React.useEffect(() => {
    if (param === undefined || src === null) return undefined;
    let live = true;
    prepareCropSource({ url: src, timeSeconds: null }).then(
      (loaded) => {
        if (live) setEl(loaded);
      },
      () => {
        // The layer stays invisible, so the node keeps showing its picture;
        // the export loads it again and says so if it fails.
      },
    );
    return () => {
      live = false;
      setEl(undefined);
      setDrawn(false);
    };
  }, [param, src]);
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  // Asked at the pixels the node takes on screen, never past the source's own;
  // previewFrame draws the source shrunk by the largest power of two that
  // still gives them, so zooming in to 1:1 shows what the export does to fine
  // detail, as an editor's 1:1 view does.
  // Read only while the layer shows, so a zoom does not re-render it on every node.
  const zoom = useStore((s) => (param === undefined ? 1 : s.transform[2]));
  const width =
    box === undefined ? 0 : Math.max(1, Math.round(Math.min(box.width * zoom * dpr, natural?.width ?? Infinity)));
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
      // A lost context is made again for the draw; graphics that still cannot
      // draw leave the layer hidden over the node's own picture, and Run says
      // what went wrong.
      void drawAdjustedPreview(next.el, next.size, next.value, target).then(
        (drew) => {
          setSpans((was) => (was?.width === drew.frame.width && was.height === drew.frame.height ? was : drew.frame));
          setDrawn(true);
        },
        () => setDrawn(false),
      );
    });
  }, [param, el, width, height, value]);

  React.useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      releasePreviewBackend();
    },
    [],
  );

  if (param === undefined || geometry === null) return null;
  const across = spans === null || natural === null ? 1 : spans.width / natural.width;
  const down = spans === null || natural === null ? 1 : spans.height / natural.height;
  return (
    <div
      className='pointer-events-none absolute overflow-hidden'
      style={{ left: geometry.at.x, top: geometry.at.y, width: geometry.box.width, height: geometry.box.height }}
    >
      <canvas
        ref={canvas}
        data-testid='mini-tool-adjust-layer'
        className={cn('absolute top-0 left-0 bg-card', drawn ? undefined : 'invisible')}
        style={{ width: geometry.box.width * across, height: geometry.box.height * down }}
      />
    </div>
  );
}
