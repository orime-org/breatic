// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { VideoToolInput } from '@breatic/shared/mini-tools';
import type { VideoTimelineDecoderBinding, VideoTimelinePresentedFrame } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';

export interface NativeTimelineDecoderProps {
  input: VideoToolInput;
  onBinding: (binding: VideoTimelineDecoderBinding | null, error?: unknown) => void;
  onPresentedFrame: (frame: VideoTimelinePresentedFrame) => void;
}

/**
 * Owns an independent native decoder for sources the caller presents natively.
 * @param props - The copied registered source and synchronous frame consumer.
 * @returns The hidden decoder attachment.
 * @throws {never} Decoder and capability failures are returned to the consumer.
 */
export function NativeTimelineDecoder(props: NativeTimelineDecoderProps): React.JSX.Element {
  const host = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const { inputId, url } = props.input;
  React.useEffect(() => {
    const attachment = host.current;
    if (attachment === null) return undefined;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous'; video.preload = 'auto'; video.playsInline = true;
    attachment.append(video);
    let active = true;
    let callbackId: number | null = null;
    let seekEpoch = 0;
    const sourceKey = JSON.stringify([inputId, url]);
    /**
     * Reports this decoder's failure without changing any other source.
     * @throws {never} Never.
     */
    function fail(): void { if (active) latest.current.onBinding(null, new Error('Timeline source decoding failed')); }
    /**
     * Captures only a genuinely presented frame from the current seek.
     * @throws {never} Frame consumers own their rendering errors.
     */
    function requestFrame(): void {
      if (!active) return;
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
      const epoch = seekEpoch;
      callbackId = video.requestVideoFrameCallback((_now, metadata) => {
        callbackId = null;
        if (!active) return;
        if (epoch === seekEpoch && !video.seeking) latest.current.onPresentedFrame({ sourceKey, sourceEpoch: 1, seekEpoch: epoch, mediaTime: metadata.mediaTime, surface: video });
        requestFrame();
      });
    }
    /**
     * Delivers the actual native element after its original geometry is known.
     * @throws {never} Never.
     */
    function ready(): void {
      if (!active) return;
      latest.current.onBinding({
        element: video, sourceKey, sourceEpoch: 1, original: { width: video.videoWidth, height: video.videoHeight },
        seek: (time) => { seekEpoch += 1; video.currentTime = time; requestFrame(); },
        play: () => video.play(), pause: () => video.pause(),
      });
    }
    video.addEventListener('error', fail); video.addEventListener('loadedmetadata', ready);
    if (typeof video.requestVideoFrameCallback !== 'function') fail();
    else { requestFrame(); video.src = url; video.load(); }
    return () => {
      active = false;
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
      video.removeEventListener('error', fail); video.removeEventListener('loadedmetadata', ready);
      video.pause(); video.removeAttribute('src'); video.load(); video.remove();
      latest.current.onBinding(null);
    };
  }, [inputId, url]);
  return <div hidden ref={host} />;
}
