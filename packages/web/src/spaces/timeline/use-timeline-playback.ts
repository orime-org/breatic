// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { TimelineDocumentV1, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import { nextTimelinePlaybackBoundary } from '@web/data/yjs/timeline-layers';
import { timelineSourceSeconds } from '@web/data/yjs/timeline-time';
import { resolveTimelineMediaTransport, timelineFrameAt, type TimelineMediaTransport } from '@web/spaces/timeline/media-transport';
import { createWebAnimationHost, type TimelineWebLayer, type WebInstanceState } from '@web/spaces/timeline/web-animation-host';

export type { TimelineWebLayer, WebInstanceState };

const NO_WEB_LAYERS: readonly TimelineWebLayer[] = [];

/** The current document projection, its authorized preview resource and the visible web-animation instances. */
export interface TimelinePlaybackInput {
  document: TimelineDocumentV1;
  readyClipIds: ReadonlySet<string>;
  frame: number;
  onFrame: (frame: number) => void;
  clip: TimelineVideoClip | null;
  source: TimelineVideoSource | null;
  media: HTMLVideoElement | null;
  enabled: boolean;
  resourceState: 'loading' | 'ready' | 'failed';
  /** The visible web-animation instances, bottom-up; an unchanged set keeps its identity. */
  webLayers?: readonly TimelineWebLayer[];
  /** Whether a visible web-animation copy has not registered its player yet; play waits for it like a loading one. */
  webPending?: boolean;
  /** How long a web-animation page may take to say its bridge is ready. */
  webLoadTimeoutMs?: number;
}

/** Local preview controls, owned by the current Timeline view. */
export interface TimelinePlayback {
  intent: 'play' | 'pause';
  state: TimelineMediaTransport;
  toggle: () => void;
  seek: (frame: number) => void;
  retry: () => void;
  /** Each visible web-animation instance's state, by instance key. */
  webStates: ReadonlyMap<string, WebInstanceState>;
  /** Load a failed web-animation instance again. */
  retryWeb: (key: string) => void;
}

/** A single observation of the user's intent and current native transport. */
interface PlaybackState { intent: 'play' | 'pause'; state: TimelineMediaTransport }

/** User controls for the currently attached media lifecycle. */
type PlaybackActions = Pick<TimelinePlayback, 'toggle' | 'seek' | 'retry' | 'retryWeb'>;

/**
 * Drive the preview against the integer-frame document clock. The current frame is ready when the visible video has
 * seeked to it and every visible web-animation instance that has not failed has answered it, including one whose
 * player has not registered yet (inner#1711 design §7.2); play waits, with the video paused and the clock frozen,
 * until it is.
 * @param input - The current frame, placement, native media element and visible web-animation instances.
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
  const webLayers = input.webLayers ?? NO_WEB_LAYERS;
  // The confirmed integer frame, shared with the web-animation host.
  const position = React.useRef(input.frame);
  // The current effect's readiness check, run when a web-animation instance changes state.
  const evaluateNow = React.useRef<(() => void) | null>(null);
  // Set when play stopped at a boundary; the render that shows the boundary frame continues from it.
  const atBoundary = React.useRef(false);
  const [webStates, setWebStates] = React.useState<ReadonlyMap<string, WebInstanceState>>(() => new Map());
  const [host] = React.useState(() => createWebAnimationHost({
    frame: () => position.current,
    timelineFps: () => latest.current.document.settings.fps,
    loadTimeoutMs: () => latest.current.webLoadTimeoutMs,
    onChange: () => {
      setWebStates(host.states());
      evaluateNow.current?.();
    },
  }));

  React.useEffect(() => {
    let active = true;
    let request = 0;
    let pendingPlay = false;
    let frameHandle: number | null = null;
    let anchor: { frame: number; at: number } | null = null;
    position.current = latest.current.frame;
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
      position.current = frame;
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
     * Freeze at the frame the current media actually reached, never before the frame this run of play started from:
     * stepping back past a boundary would bring back what was visible before it. Held at a boundary, the frame stays.
     * @throws {never} Never.
     */
    function freezeMedia(): void {
      if (anchor !== null && media !== null && clip !== null && source !== null && !awaitingSeek && Number.isFinite(media.currentTime)) {
        const fps = latest.current.document.settings.fps;
        const sourceIn = clip.sourceInFrame * source.timebase.den / source.timebase.num;
        const frame = clip.startFrame + Math.floor((media.currentTime - sourceIn) * fps.num * clip.rate.den / (fps.den * clip.rate.num));
        showFrame(Math.max(anchor.frame, clip.startFrame, Math.min(clip.startFrame + clip.durationFrames - 1, frame)));
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
      // Playback stops where the shown clip changes; edges hidden under a higher track do not count.
      const boundary = nextTimelinePlaybackBoundary(latest.current.document, latest.current.readyClipIds, position.current, end);
      const next = Math.min(boundary, timelineFrameAt(anchor, now, fps, end));
      if (next >= end) {
        showFrame(Math.max(0, end - 1));
        media?.pause();
        anchor = null;
        sequenceEnded = true;
        publish('pause', 'paused');
        return;
      }
      showFrame(next);
      if (next >= boundary) {
        // What is visible changes here; the render that shows this frame checks the new layers and goes on.
        anchor = null;
        atBoundary.current = true;
        return;
      }
      host.sendFrame();
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
        && !awaitingSeek && position.current === clip.startFrame + clip.durationFrames - 1
        && media.currentTime >= Number(source.durationSeconds);
      const webReady = host.ready() && latest.current.webPending !== true;
      const next = clip === null || terminalHold ? (webReady ? 'playing' : 'waiting') : resolveTimelineMediaTransport({
        intent: 'play', generationMatches: true, targetReady: !awaitingSeek && resourceState === 'ready' && webReady,
        paused: media?.paused ?? true, seeking: media?.seeking ?? true,
        ended: media?.ended ?? false, error: false, readyState: media?.readyState ?? 0,
      });
      if (next === 'playing') {
        if (anchor === null) anchor = { frame: position.current, at: performance.now() };
        publish('play', 'playing');
        schedule();
        return;
      }
      if (state.current.state === 'playing') {
        freezeMedia();
        // The video went on while a web instance was not ready; it is placed back on the frozen frame.
        if (!webReady && clip !== null && source !== null && position.current >= clip.startFrame && position.current < clip.startFrame + clip.durationFrames) {
          targetSeconds = timelineSourceSeconds(clip, source, latest.current.document.settings.fps, position.current);
          awaitingSeek = true;
          seekAssigned = false;
        }
      }
      publish('play', 'waiting');
      if (!webReady) {
        if (pendingPlay) { request += 1; pendingPlay = false; }
        if (media !== null && !media.paused) media.pause();
        return;
      }
      if (media !== null && !awaitingSeek && media.readyState >= 3 && media.paused && !media.ended && resourceState === 'ready') requestPlay();
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
      repositionWeb();
      if (clip !== null && source !== null && position.current >= clip.startFrame && position.current < clip.startFrame + clip.durationFrames) {
        targetSeconds = timelineSourceSeconds(clip, source, latest.current.document.settings.fps, position.current);
        awaitingSeek = true;
        seekAssigned = false;
        evaluate();
      } else {
        media?.pause();
        publish(state.current.intent, state.current.intent === 'play' ? 'waiting' : 'paused');
        if (clip === null) evaluate();
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
        repositionWeb();
      } else {
        if (sequenceEnded) seek(0);
        else repositionWeb();
        publish('play', 'waiting');
        evaluate();
      }
    }

    /**
     * Send every web-animation instance the current frame under a new sequence.
     * @throws {never} Never.
     */
    function repositionWeb(): void {
      host.reposition();
      setWebStates(host.states());
    }

    /**
     * Load a failed web-animation instance again.
     * @param key - The instance key.
     * @throws {never} Never.
     */
    function retryWeb(key: string): void {
      host.retry(key);
      setWebStates(host.states());
      evaluate();
    }

    /**
     * Retry the current frame after an explicit user request.
     * @throws {never} Never.
     */
    function retry(): void {
      if (media?.error) {
        try {
          media.load();
          configureMedia();
        } catch {
          fail();
          return;
        }
      }
      seek(position.current);
      publish('play', 'waiting');
      evaluate();
    }

    /**
     * Apply the current placement's native settings after attachment or reload.
     * @throws {DOMException} When the browser rejects a media setting.
     */
    function configureMedia(): void {
      if (media !== null && clip !== null) {
        media.playbackRate = clip.rate.num / clip.rate.den;
        media.volume = Math.min(1, clip.gain);
        media.muted = clip.mute;
      }
    }

    if (clip !== null && source !== null) {
      targetSeconds = timelineSourceSeconds(clip, source, latest.current.document.settings.fps, position.current);
      configureMedia();
    }
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'play', 'pause', 'waiting', 'stalled', 'seeked', 'seeking', 'timeupdate', 'ended', 'error'];
    for (const event of events) media?.addEventListener(event, evaluate);
    actions.current = { toggle, seek, retry, retryWeb };
    evaluateNow.current = evaluate;
    evaluate();
    return () => {
      active = false;
      evaluateNow.current = null;
      request += 1;
      cancelFrame();
      for (const event of events) media?.removeEventListener(event, evaluate);
      media?.pause();
      actions.current = null;
    };
  }, [clip, source, media, enabled, resourceState, host]);

  React.useEffect(() => () => {
    state.current = { intent: 'pause', state: 'paused' };
  }, []);

  // The bridge's replies arrive on the window; only the iframe of an attached instance is listened to.
  React.useEffect(() => {
    /**
     * Hand a window message to the host.
     * @param event - The message.
     * @throws {never} Never.
     */
    const receive = (event: MessageEvent): void => { host.receive(event); };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      // A hidden Space tab runs no effects; showing it again attaches every instance afresh with a new hello.
      host.dispose();
    };
  }, [host]);

  React.useEffect(() => {
    host.sync(webLayers);
    setWebStates(host.states());
    evaluateNow.current?.();
  }, [host, webLayers]);

  React.useEffect(() => {
    evaluateNow.current?.();
  }, [input.webPending]);

  React.useEffect(() => {
    if (!atBoundary.current) return;
    atBoundary.current = false;
    evaluateNow.current?.();
  }, [input.frame]);

  const toggle = React.useCallback((): void => actions.current?.toggle(), []);
  const seek = React.useCallback((frame: number): void => actions.current?.seek(frame), []);
  const retry = React.useCallback((): void => actions.current?.retry(), []);
  const retryWeb = React.useCallback((key: string): void => actions.current?.retryWeb(key), []);
  return { ...snapshot, toggle, seek, retry, webStates, retryWeb };
}
