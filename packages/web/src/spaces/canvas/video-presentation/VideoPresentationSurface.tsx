// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { cn } from '@web/lib/utils';
import { checkerboardStyle } from '@web/spaces/canvas/_shared/checkerboard';
import { useMediaSurface } from '@web/spaces/canvas/video-presentation/use-media-surface';
import type { PresentedMediaFrame, MediaSurfaceSnapshot, VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';

/** Leaf presentation props; product controls and status copy stay with callers. */
export interface VideoPresentationSurfaceProps {
  source: VideoPresentationSource | null;
  active: boolean;
  onBinding: (snapshot: MediaSurfaceSnapshot) => void;
  onPresentedFrame?: (frame: PresentedMediaFrame) => void;
  /** Called when the page pool releases the renderer; without it a new renderer starts at once. */
  onEvicted?: () => void;
  className?: string;
  children?: React.ReactNode;
}
const DETACHED: MediaSurfaceSnapshot = { status: 'detached', binding: null, error: null };

/**
 * Renders a native or alpha picture inside the existing canvas media controls.
 * @param props - Resolved source, Space activity and existing control children.
 * @param props.source - Canonical classification and owned manifest.
 * @param props.active - Whether the owning Space or preview is visible.
 * @param props.onBinding - Actual element, resource status and fullscreen target.
 * @param props.onPresentedFrame - Synchronous draw consumer; upload or copy before returning.
 * @param props.onEvicted - Takes over after the page pool releases the renderer.
 * @param props.className - Existing node surface styling.
 * @param props.children - Existing custom controls, included in fullscreen.
 * @returns An original-sized presentation surface with no native controls.
 * @throws {never} Resource failures are reported through onBinding.
 */
export function VideoPresentationSurface({ source, active, onBinding, onPresentedFrame, onEvicted, className, children }: VideoPresentationSurfaceProps): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const container = React.useRef<HTMLDivElement>(null);
  const { status, binding, error } = useMediaSurface({ host, container, source, active, onPresentedFrame, onEvicted });
  const snapshot = React.useMemo(() => ({ status, binding, error }), [status, binding, error]);
  // A transparent picture shows the canvas checkerboard through its alpha, as an expansion's painted area does.
  const style = React.useMemo(() => source ? { aspectRatio: `${source.presentation.display.width}/${source.presentation.display.height}`,
    ...(source.presentation.playback.kind === 'alpha-packed' ? checkerboardStyle(1, { x: 0, y: 0 }) : {}) } : undefined, [source]);
  React.useEffect(() => { onBinding(snapshot); }, [snapshot, onBinding]);
  React.useEffect(() => () => onBinding(DETACHED), [onBinding]);
  return (
    <div ref={container} className={cn('relative w-full', className)} style={style} data-video-presentation={status}>
      <div ref={host} className='absolute inset-0' />
      {children}
    </div>
  );
}
