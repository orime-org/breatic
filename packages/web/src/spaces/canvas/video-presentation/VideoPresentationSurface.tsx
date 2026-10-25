// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { cn } from '@web/lib/utils';
import { useMediaSurface } from '@web/spaces/canvas/video-presentation/use-media-surface';
import type { PresentedMediaFrame, MediaSurfaceSnapshot, VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';

/** Leaf presentation props; product controls and status copy stay with callers. */
export interface VideoPresentationSurfaceProps {
  source: VideoPresentationSource | null;
  active: boolean;
  onBinding: (snapshot: MediaSurfaceSnapshot) => void;
  onPresentedFrame?: (frame: PresentedMediaFrame) => void;
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
 * @param props.className - Existing node surface styling.
 * @param props.children - Existing custom controls, included in fullscreen.
 * @returns An original-sized presentation surface with no native controls.
 * @throws {never} Resource failures are reported through onBinding.
 */
export function VideoPresentationSurface({ source, active, onBinding, onPresentedFrame, className, children }: VideoPresentationSurfaceProps): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const container = React.useRef<HTMLDivElement>(null);
  const { status, binding, error } = useMediaSurface({ host, container, source, active, onPresentedFrame });
  const snapshot = React.useMemo(() => ({ status, binding, error }), [status, binding, error]);
  const style = React.useMemo(() => source ? { aspectRatio: `${source.presentation.original.width}/${source.presentation.original.height}` } : undefined, [source]);
  React.useEffect(() => { onBinding(snapshot); }, [snapshot, onBinding]);
  React.useEffect(() => () => onBinding(DETACHED), [onBinding]);
  return (
    <div ref={container} className={cn('relative w-full', className)} style={style} data-video-presentation={status}>
      <div ref={host} className='absolute inset-0' />
      {children}
    </div>
  );
}
