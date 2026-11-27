// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { createVideoRenderer } from '@web/spaces/canvas/video-presentation/create-video-renderer';
import { createPresentedFrameClock, type PresentedFrameClock } from '@web/spaces/canvas/video-presentation/presented-frame-clock';
import { presentedSizeOf, runtimeSourceKeyOf, type PresentedMediaFrame, type MediaSurfaceBinding, type MediaSurfaceSnapshot, type VideoPresentationSource, type VideoRendererFactory, type VideoRendererResource } from '@web/spaces/canvas/video-presentation/types';

/** Options for one effect-owned canvas video surface. */
export interface MediaSurfaceOptions {
  host: React.RefObject<HTMLDivElement | null>;
  container?: React.RefObject<HTMLDivElement | null>;
  source: VideoPresentationSource | null;
  active: boolean;
  createRenderer?: VideoRendererFactory;
  onPresentedFrame?: (frame: PresentedMediaFrame) => void;
  /** Called when the page pool releases the renderer; the surface stays detached and never restarts on its own. */
  onEvicted?: () => void;
}
/** Resource state plus an explicit retry action. */
export interface MediaSurfaceApi extends MediaSurfaceSnapshot { retry: () => void }
const DETACHED: MediaSurfaceSnapshot = { status: 'detached', binding: null, error: null };

/**
 * Owns a source's actual video resource for the active Space.
 * @param options - Host, validated source and visibility.
 * @param options.host - The element owned exclusively by this renderer.
 * @param options.container - Optional outer container including existing controls.
 * @param options.source - Resolved canonical classification and optional manifest.
 * @param options.active - Whether the owning Space or preview is visible.
 * @param options.createRenderer - Renderer factory, injectable for lifecycle tests.
 * @param options.onPresentedFrame - Synchronous consumer of the committed drawable frame.
 * @param options.onEvicted - Told after the page pool releases the renderer, which the owner builds again only when the user
 *   reaches it: restarting at once would evict the next idle renderer, and a page of them would evict each other forever.
 * @returns Current resource state and a retry command.
 * @throws {never} Resource failures are reported in the snapshot.
 */
export function useMediaSurface({ host, container, source, active, createRenderer = createVideoRenderer, onPresentedFrame, onEvicted }: MediaSurfaceOptions): MediaSurfaceApi {
  const [snapshot, setSnapshot] = React.useState<MediaSurfaceSnapshot>(DETACHED);
  const [attempt, setAttempt] = React.useState(0);
  const sourceEpoch = React.useRef(0);
  const onPresentedFrameRef = React.useRef(onPresentedFrame);
  React.useEffect(() => { onPresentedFrameRef.current = onPresentedFrame; }, [onPresentedFrame]);
  const onEvictedRef = React.useRef(onEvicted);
  React.useEffect(() => { onEvictedRef.current = onEvicted; }, [onEvicted]);
  const retry = React.useCallback((): void => setAttempt((value) => value + 1), []);

  React.useEffect(() => {
    if (!active || !source || !host.current) { setSnapshot(DETACHED); return; }
    // Only a selected version of this very source reaches a renderer (§7.8); the version was validated by the read it came in.
    if (source.presentation.sourceFingerprint !== source.sourceFingerprint) { setSnapshot({ status: 'failed', binding: null, error: 'invalid-presentation' }); return; }
    const original = presentedSizeOf(source.presentation);
    setSnapshot({ status: 'loading', binding: null, error: null });

    const epoch = ++sourceEpoch.current;
    // The key names the version this resource shows; no binding reports it before the resource is ready (§3.3).
    const sourceKey = runtimeSourceKeyOf(source);
    let live = true;
    let terminal = false;
    let contextLost = false;
    let released = false;
    let resource: VideoRendererResource | undefined;
    let binding: MediaSurfaceBinding | null = null;
    let clock: PresentedFrameClock | undefined;

    /**
     * Releases a partially or fully initialized instance exactly once.
     * @throws {never} Renderer cleanup owns its platform errors.
     */
    function release(): void {
      if (released) return;
      released = true;
      clock?.dispose();
      binding?.element.pause();
      binding = null;
      resource?.dispose();
    }
    /**
     * Publishes only the current instance's resource failure.
     * @param code - Stable failure code for the existing product error UI.
     * @throws {never} Never.
     */
    function fail(code: string): void {
      if (!live || terminal) return;
      terminal = true;
      release();
      setSnapshot({ status: 'failed', binding: null, error: code });
    }
    try {
      resource = createRenderer(host.current, source, {
        ready: (element, surface) => {
          if (!live || terminal) return;
          if (binding?.element === element && binding.surface === surface) return;
          clock?.dispose();
          binding?.element.pause();
          element.pause();
          clock = createPresentedFrameClock(element, surface, sourceKey, epoch, (frame) => { if (live && !terminal) onPresentedFrameRef.current?.(frame); });
          const frameClock = clock;
          binding = {
            sourceKey, sourceEpoch: epoch, element, surface, container: container?.current ?? host.current!, original,
            getSeekEpoch: frameClock.getSeekEpoch,
            getPresentedFrame: frameClock.getFrame,
            seek: (seconds) => {
              if (!live || terminal || !Number.isFinite(seconds)) return;
              frameClock.invalidate();
              const mediaEnd = Number.isFinite(element.duration) && element.duration >= 0 ? element.duration : Infinity;
              element.currentTime = Math.min(mediaEnd, Math.max(0, seconds));
            },
            play: async () => {
              if (!live || terminal) return;
              try { await element.play(); }
              catch (error) {
                // A later pause or load interrupted this play: the player was not refused, and pausing again would stop
                // the playback that superseded it.
                if (error instanceof DOMException && error.name === 'AbortError') throw error;
                if (live && !terminal && binding?.element === element) {
                  element.pause();
                  setSnapshot({ status: 'ready', binding, error: 'play-rejected' });
                }
                throw error;
              }
            },
            pause: () => { if (live && !terminal) element.pause(); },
          };
          setSnapshot({ status: 'ready', binding, error: null });
        },
        getSeekEpoch: () => clock?.getSeekEpoch() ?? 0,
        frame: (mediaTime, seekEpoch) => {
          if (!live || terminal) return;
          const frame = clock?.commit(mediaTime, seekEpoch);
          if (frame) onPresentedFrameRef.current?.(frame);
        },
        error: fail,
        contextLost: () => {
          if (!live || terminal) return;
          contextLost = true;
          terminal = true;
          clock?.dispose();
          binding?.element.pause();
          binding = null;
          setSnapshot({ status: 'failed', binding: null, error: 'webgl-context-lost' });
        },
        contextRestored: () => { if (live && contextLost) retry(); },
        evicted: () => {
          if (!live || terminal) return;
          terminal = true;
          release();
          setSnapshot(DETACHED);
          onEvictedRef.current?.();
        },
      });
      if (released) resource.dispose();
    } catch {
      fail('renderer-initialization-failed');
    }
    return () => { live = false; terminal = true; release(); };
  }, [active, source, host, container, createRenderer, attempt, retry]);

  return React.useMemo(() => ({ ...snapshot, retry }), [snapshot, retry]);
}
