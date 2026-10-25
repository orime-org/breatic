// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { timelineSourceSeconds, type TimelineDocumentV1, type TimelineVideoClip, type TimelineVideoSource } from '@breatic/shared';
import { resolveTimelineMediaTransport, timelineFrameAt, type TimelineMediaTransport } from '@web/spaces/timeline/media-transport';

/** The current document projection and its authorized preview resource. */
export interface TimelinePlaybackInput {
  document: TimelineDocumentV1;
  frame: number;
  onFrame: (frame: number) => void;
  clip: TimelineVideoClip | null;
  source: TimelineVideoSource | null;
  media: HTMLVideoElement | null;
  enabled: boolean;
  resourceState: 'loading' | 'ready' | 'failed';
}

/** Local preview controls, owned by the current Timeline view. */
export interface TimelinePlayback {
  intent: 'play' | 'pause';
  state: TimelineMediaTransport;
  toggle: () => void;
  seek: (frame: number) => void;
  retry: () => void;
}

/** A single observation of the user's intent and current native transport. */
interface PlaybackState { intent: 'play' | 'pause'; state: TimelineMediaTransport }

/** User controls for the currently attached media lifecycle. */
type PlaybackActions = Pick<TimelinePlayback, 'toggle' | 'seek' | 'retry'>;

/**
 * Drive the preview against the integer-frame document clock.
 * @param input - The current frame, placement and native media element.
 * @returns The local transport state and user controls.
 * @throws {never} Never.
 */
export function useTimelinePlayback(input: TimelinePlaybackInput): TimelinePlayback {
  const latest = React.useRef(input);
  latest.current = input;
  const state = React.useRef<PlaybackState>({ intent: 'pause', state: 'paused' });
  const [snapshot, setSnapshot] = React.useState(state.current);
  const actions = React.useRef<PlaybackActions | null>(null);
  const { clip, source, media, enabled, resourceState } = input;

  React.useEffect(() => {
    let active = true;
    let request = 0;
    let pendingPlay = false;
    let frameHandle: number | null = null;
    let anchor: { frame: number; at: number } | null = null;
    let position = latest.current.frame;
    let targetSeconds = 0;
    let awaitingSeek = clip !== null;
    let seekAssigned = false;
    let sequenceEnded = false;
    setSnapshot(state.current);

    /**
     * Publish a changed transport observation.
     * @param intent - The current user intent.
     * @param next - The current native transport result.
     * @throws {never} Never.
     */
    function publish(intent: PlaybackState['intent'], next: TimelineMediaTransport): void {
      if (state.current.intent === intent && state.current.state === next) return;
      state.current = { intent, state: next };
      setSnapshot(state.current);
    }

    /**
     * End the outstanding animation frame.
     * @throws {never} Never.
     */
    function cancelFrame(): void {
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }

    /**
     * Publish the current integer position.
     * @param frame - The confirmed integer frame.
     * @throws {never} Never.
     */
    function showFrame(frame: number): void {
      position = frame;
      if (latest.current.frame !== frame) latest.current.onFrame(frame);
    }

    /**
     * Read the half-open sequence endpoint from the current document.
     * @returns The first frame beyond the sequence.
     * @throws {never} Never.
     */
    function sequenceEnd(): number {
      return Math.max(0, ...Object.values(latest.current.document.clips).map((item) => item.startFrame + item.durationFrames));
    }

    /**
     * Freeze at the frame the current media actually reached.
     * @throws {never} Never.
     */
    function freezeMedia(): void {
      if (media !== null && clip !== null && source !== null && !awaitingSeek && Number.isFinite(media.currentTime)) {
        const fps = latest.current.document.settings.fps;
        const sourceIn = clip.sourceInFrame * source.timebase.den / source.timebase.num;
        const frame = clip.startFrame + Math.floor((media.currentTime - sourceIn) * fps.num * clip.rate.den / (fps.den * clip.rate.num));
        showFrame(Math.max(clip.startFrame, Math.min(clip.startFrame + clip.durationFrames - 1, frame)));
      }
      anchor = null;
      cancelFrame();
    }

    /**
     * Stop at a current media or resource failure.
     * @throws {never} Never.
     */
    function fail(): void {
      if (state.current.state === 'playing') freezeMedia();
      cancelFrame();
      anchor = null;
      request += 1;
      pendingPlay = false;
      media?.pause();
      publish('pause', 'failed');
    }

    /**
     * Schedule one observation of the global clock.
     * @throws {never} Never.
     */
    function schedule(): void {
      if (!active || frameHandle !== null || state.current.state !== 'playing') return;
      frameHandle = requestAnimationFrame(tick);
    }

    /**
     * Advance to the next source barrier or sequence endpoint.
     * @param now - The monotonic browser timestamp.
     * @throws {never} Never.
     */
    function tick(now: number): void {
      frameHandle = null;
      if (!active || state.current.intent !== 'play' || state.current.state !== 'playing' || anchor === null) return;
      const end = sequenceEnd();
      const fps = latest.current.document.settings.fps;
      const next = timelineFrameAt(anchor, now, fps, end);
      if (next >= end) {
        showFrame(Math.max(0, end - 1));
        media?.pause();
        anchor = null;
        sequenceEnded = true;
        publish('pause', 'paused');
        return;
      }
      const boundary = clip !== null
        ? clip.startFrame + clip.durationFrames
        : Math.min(end, ...Object.values(latest.current.document.clips).filter((item) => item.startFrame > position).map((item) => item.startFrame));
      showFrame(Math.min(next, boundary));
      if (next >= boundary) {
        anchor = null;
        return;
      }
      schedule();
    }

    /**
     * Start the native element and verify its current facts on settlement.
     * @throws {never} Never.
     */
    function requestPlay(): void {
      if (media === null || pendingPlay) return;
      pendingPlay = true;
      const currentRequest = request;
      try {
        void media.play().then(() => {
          if (!active || currentRequest !== request || state.current.intent !== 'play') {
            if (!active || state.current.intent === 'pause') media.pause();
            return;
          }
          pendingPlay = false;
          evaluate();
        }, () => {
          if (active && currentRequest === request && state.current.intent === 'play') fail();
        });
      } catch {
        fail();
      }
    }

    /**
     * Read all readiness conditions from the current native element.
     * @throws {never} Never.
     */
    function evaluate(): void {
      if (!active) return;
      if (!enabled) {
        media?.pause();
        cancelFrame();
        publish('pause', 'paused');
        return;
      }
      if (resourceState === 'failed' || (clip !== null && source === null) || media?.error) {
        fail();
        return;
      }
      if (media !== null && clip !== null && source !== null && awaitingSeek && media.readyState >= 1) {
        try {
          if (!seekAssigned) {
            seekAssigned = true;
            if (media.currentTime !== targetSeconds) media.currentTime = targetSeconds;
          }
          const fps = latest.current.document.settings.fps;
          if (!media.seeking && media.readyState >= 2 && Math.abs(media.currentTime - targetSeconds) < fps.den / (2 * fps.num)) awaitingSeek = false;
        } catch {
          fail();
          return;
        }
      }
      if (state.current.intent === 'pause') {
        if (media !== null && !media.paused) media.pause();
        publish('pause', 'paused');
        return;
      }
      const terminalHold = media !== null && clip !== null && source !== null && media.ended
        && !awaitingSeek && position === clip.startFrame + clip.durationFrames - 1
        && media.currentTime >= Number(source.durationSeconds);
      const next = clip === null || terminalHold ? 'playing' : resolveTimelineMediaTransport({
        intent: 'play', generationMatches: true, targetReady: !awaitingSeek && resourceState === 'ready',
        paused: media?.paused ?? true, seeking: media?.seeking ?? true,
        ended: media?.ended ?? false, error: false, readyState: media?.readyState ?? 0,
      });
      if (next === 'playing') {
        if (anchor === null) anchor = { frame: position, at: performance.now() };
        publish('play', 'playing');
        schedule();
      } else {
        if (state.current.state === 'playing') freezeMedia();
        publish('play', 'waiting');
        if (media !== null && !awaitingSeek && media.readyState >= 3 && media.paused && !media.ended && resourceState === 'ready') requestPlay();
      }
    }

    /**
     * Set an explicit user seek and preserve the current play intent.
     * @param frame - The requested integer Timeline frame.
     * @throws {never} Never.
     */
    function seek(frame: number): void {
      if (!Number.isSafeInteger(frame)) return;
      request += 1;
      pendingPlay = false;
      cancelFrame();
      anchor = null;
      sequenceEnded = false;
      showFrame(Math.max(0, Math.min(Math.max(0, sequenceEnd() - 1), frame)));
      if (clip !== null && source !== null && position >= clip.startFrame && position < clip.startFrame + clip.durationFrames) {
        targetSeconds = timelineSourceSeconds(clip, source, latest.current.document.settings.fps, position);
        awaitingSeek = true;
        seekAssigned = false;
        evaluate();
      } else {
        media?.pause();
        publish(state.current.intent, state.current.intent === 'play' ? 'waiting' : 'paused');
      }
    }

    /**
     * Toggle the current user's playback intent.
     * @throws {never} Never.
     */
    function toggle(): void {
      if (!enabled || sequenceEnd() === 0) return;
      if (state.current.intent === 'play') {
        if (state.current.state === 'playing') freezeMedia();
        request += 1;
        pendingPlay = false;
        media?.pause();
        cancelFrame();
        anchor = null;
        publish('pause', 'paused');
      } else {
        if (sequenceEnded) seek(0);
        publish('play', 'waiting');
        evaluate();
      }
    }

    /**
     * Retry the current frame after an explicit user request.
     * @throws {never} Never.
     */
    function retry(): void {
      seek(position);
      publish('play', 'waiting');
      evaluate();
    }

    if (clip !== null && source !== null) {
      targetSeconds = timelineSourceSeconds(clip, source, latest.current.document.settings.fps, position);
      if (media !== null) {
        media.playbackRate = clip.rate.num / clip.rate.den;
        media.volume = Math.min(1, clip.gain);
        media.muted = clip.mute;
      }
    }
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'play', 'pause', 'waiting', 'stalled', 'seeked', 'seeking', 'timeupdate', 'ended', 'error'];
    for (const event of events) media?.addEventListener(event, evaluate);
    actions.current = { toggle, seek, retry };
    evaluate();
    return () => {
      active = false;
      request += 1;
      cancelFrame();
      for (const event of events) media?.removeEventListener(event, evaluate);
      media?.pause();
      actions.current = null;
    };
  }, [clip, source, media, enabled, resourceState]);

  React.useEffect(() => () => {
    state.current = { intent: 'pause', state: 'paused' };
  }, []);

  const toggle = React.useCallback((): void => actions.current?.toggle(), []);
  const seek = React.useCallback((frame: number): void => actions.current?.seek(frame), []);
  const retry = React.useCallback((): void => actions.current?.retry(), []);
  return { ...snapshot, toggle, seek, retry };
}
