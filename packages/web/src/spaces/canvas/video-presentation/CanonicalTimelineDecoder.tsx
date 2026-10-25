// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { VideoToolInput } from '@breatic/shared/mini-tools';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { useResolvedVideoPresentation } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import { VideoPresentationSurface } from '@web/spaces/canvas/video-presentation/VideoPresentationSurface';
import type { MediaSurfaceSnapshot, PresentedMediaFrame } from '@web/spaces/canvas/video-presentation/types';
import type { VideoTimelineDecoderBinding } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';

interface CanonicalTimelineDecoderProps {
  input: VideoToolInput;
  onBinding: (binding: VideoTimelineDecoderBinding | null, error?: unknown) => void;
  onPresentedFrame: (frame: PresentedMediaFrame) => void;
}

/**
 * Gives each composition slot an independently owned native or alpha decoder.
 * @param props - Copied canonical input and synchronous texture consumer.
 * @returns The real presentation decoder, never a URL-based codec guess.
 * @throws {never} Failures are returned to the existing preview recovery state.
 */
export function CanonicalTimelineDecoder(props: CanonicalTimelineDecoderProps): React.JSX.Element {
  const { projectId } = useCanvasContext();
  const { source, failure } = useResolvedVideoPresentation(projectId, props.input.url, true);
  const latest = React.useRef(props);
  latest.current = props;
  /**
   * Returns the actual transport once metadata is ready, independently of first draw.
   * @param notice - Owned source attachment state.
   * @throws {never} Never.
   */
  const bind = React.useCallback((notice: MediaSurfaceSnapshot): void => latest.current.onBinding(notice.binding, notice.error ?? failure ?? undefined), [failure]);
  /**
   * Delivers a draw before VAP can clear its transient buffer.
   * @param frame - The current actual drawable frame.
   * @throws {never} The compositor owns pixel-read failures.
   */
  const frame = React.useCallback((frame: PresentedMediaFrame): void => latest.current.onPresentedFrame(frame), []);
  return <VideoPresentationSurface source={source} active onBinding={bind} onPresentedFrame={frame} />;
}
