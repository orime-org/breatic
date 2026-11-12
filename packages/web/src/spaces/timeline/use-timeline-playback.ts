// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { TIMELINE_PREVIEW_DEFAULTS, t, type TimelineDocumentV1, type TimelinePreviewSyncLimits } from '@breatic/shared';
import { nextTimelinePlaybackBoundary } from '@web/data/yjs/timeline-layers';
import { timelineSourceSeconds } from '@web/data/yjs/timeline-time';
import { toast } from '@web/lib/toast';
import { timelineFrameAt, type TimelineMediaTransport } from '@web/spaces/timeline/media-transport';
import {
  createVideoLayerController, reachableTime, videoLaneClip, videoLaneMapping, videoLaneSourceSeconds,
  type TimelineVideoLayer, type TimelineVideoLayerState, type VideoLane,
} from '@web/spaces/timeline/video-layer-controller';
import { createWebAnimationHost, type TimelineWebLayer, type WebInstanceState } from '@web/spaces/timeline/web-animation-host';

export type { TimelineVideoLayer, TimelineVideoLayerState, TimelineWebLayer, WebInstanceState };

const NO_WEB_LAYERS: readonly TimelineWebLayer[] = [];
const NO_VIDEO_LAYERS: readonly TimelineVideoLayer[] = [];
// An element this close to its file end shows the last picture (`media.js:279-283`).
const END_TOLERANCE_SECONDS = 0.001;

/** The document, the visible and premounted video layers, and the visible web-animation instances. */
export interface TimelinePlaybackInput {
  document: TimelineDocumentV1;
  readyClipIds: ReadonlySet<string>;
  frame: number;
  onFrame: (frame: number) => void;
  /** Every visible video clip and every one starting within the premount lead, bottom-up; an unchanged set keeps its identity. */
  videoLayers?: readonly TimelineVideoLayer[];
  /** Makes a clip's element; a `<video>` by default. */
  createMedia?: (clipId: string) => HTMLVideoElement;
  enabled: boolean;
  /** The drift thresholds; the shared defaults until the Timeline limits arrive. */
  preview?: TimelinePreviewSyncLimits;
  /** The web-animation instances with their pool roles, visible ones bottom-up; an unchanged set keeps its identity. */
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
  /** Each video layer's state, by clip id. */
  videoStates: ReadonlyMap<string, TimelineVideoLayerState>;
  /** A video clip's element, for its layer to mount. */
  videoElement: (clipId: string) => HTMLVideoElement | undefined;
  /** Load one video layer again; the preview waits for it like a newly visible one. */
  retryVideo: (clipId: string) => void;
  /** Each visible web-animation instance's state, by instance key. */
  webStates: ReadonlyMap<string, WebInstanceState>;
  /** Load a failed web-animation instance again. */
  retryWeb: (key: string) => void;
}

/** A single observation of the user's intent and the preview transport. */
interface PlaybackState { intent: 'play' | 'pause'; state: TimelineMediaTransport }

/** User controls bound to the current effect. */
type PlaybackActions = Pick<TimelinePlayback, 'toggle' | 'seek' | 'retryVideo' | 'retryWeb'> & { placementChanged: () => void };

/**
 * Whether an element shows its file's last picture: within 1 ms of its end (`media.js:279-283`). A browser reports
 * `ended` only there, so the position decides.
 * @param element - The element.
 * @returns Whether it is at its end.
 * @throws {never} Never.
 */
function atFileEnd(element: HTMLVideoElement): boolean {
  return Number.isFinite(element.duration) && Math.abs(element.currentTime - element.duration) <= END_TOLERANCE_SECONDS;
}

/**
 * Whether two state maps hold the same entries.
 * @param a - One map.
 * @param b - The other.
 * @returns Whether they are equal.
 * @throws {never} Never.
 */
function sameStates(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * Drive the preview over every visible video layer and web-animation copy on one clock (#1410 design §6). The clock is
 * an anchor plus `performance.now()`; each video lane is steered or hard-synced to it by the rules ported from the
 * HyperFrames runtime, and whenever a lane must seek, buffers or newly appears, the whole preview freezes on the
 * current frame and goes on from it once every lane is in place.
 * @param input - The document, frame, video layers and web-animation instances.
 * @returns The transport state and user controls.
 * @throws {never} Never.
 */
export function useTimelinePlayback(input: TimelinePlaybackInput): TimelinePlayback {
  const latest = React.useRef(input);
  latest.current = input;
  const state = React.useRef<PlaybackState>({ intent: 'pause', state: 'paused' });
  const [snapshot, setSnapshot] = React.useState(state.current);
  const actions = React.useRef<PlaybackActions | null>(null);
  const { enabled } = input;
  const webLayers = input.webLayers ?? NO_WEB_LAYERS;
  const videoLayers = input.videoLayers ?? NO_VIDEO_LAYERS;
  // The confirmed integer frame, shared with the web-animation host and the video controller.
  const position = React.useRef(input.frame);
  // The current effect's readiness check, run when an instance or element changes.
  const evaluateNow = React.useRef<(() => void) | null>(null);
  // Set when play reached a boundary; the render that shows the boundary frame checks the new layers.
  const atBoundary = React.useRef(false);
  const [webStates, setWebStates] = React.useState<ReadonlyMap<string, WebInstanceState>>(() => new Map());
  const [videoStates, setVideoStates] = React.useState<ReadonlyMap<string, TimelineVideoLayerState>>(() => new Map());
  const [host] = React.useState(() => createWebAnimationHost({
    frame: () => position.current,
    timelineFps: () => latest.current.document.settings.fps,
    loadTimeoutMs: () => latest.current.webLoadTimeoutMs,
    onChange: () => {
      setWebStates(host.states());
      evaluateNow.current?.();
    },
  }));
  const [controller] = React.useState(() => createVideoLayerController({
    document: () => latest.current.document,
    frame: () => position.current,
    createMedia: (clipId) => latest.current.createMedia?.(clipId) ?? document.createElement('video'),
    onChange: () => evaluateNow.current?.(),
  }));

  // Declared before the playback effect: under StrictMode the remount syncs the lanes again before checking them.
  React.useEffect(() => () => controller.dispose(), [controller]);
  React.useEffect(() => {
    controller.sync(videoLayers);
    evaluateNow.current?.();
  }, [controller, videoLayers]);

  React.useEffect(() => {
    let active = true;
    let frameHandle: number | null = null;
    let anchor: { frame: number; at: number } | null = null;
    // Where the clock reached the boundary it stopped at, to go on from without losing time.
    let boundaryAnchor: { frame: number; at: number } | null = null;
    let sequenceEnded = false;
    position.current = latest.current.frame;
    setSnapshot(state.current);

    /**
     * Publish a changed transport observation.
     * @param intent - The user intent.
     * @param next - The transport state.
     * @throws {never} Never.
     */
    function publish(intent: PlaybackState['intent'], next: TimelineMediaTransport): void {
      if (state.current.intent === intent && state.current.state === next) return;
      state.current = { intent, state: next };
      setSnapshot(state.current);
    }

    /**
     * The drift thresholds in force.
     * @returns The thresholds.
     * @throws {never} Never.
     */
    function limits(): TimelinePreviewSyncLimits {
      return latest.current.preview ?? TIMELINE_PREVIEW_DEFAULTS;
    }

    /**
     * Half a Timeline frame in seconds, the tolerance of a landed seek and of a user seek, play or pause.
     * @returns The tolerance.
     * @throws {never} Never.
     */
    function halfFrame(): number {
      const fps = latest.current.document.settings.fps;
      return fps.den / (2 * fps.num);
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
     * @param frame - The frame.
     * @throws {never} Never.
     */
    function showFrame(frame: number): void {
      position.current = frame;
      if (latest.current.frame !== frame) latest.current.onFrame(frame);
    }

    /**
     * The half-open sequence end.
     * @returns The first frame beyond the sequence.
     * @throws {never} Never.
     */
    function sequenceEnd(): number {
      return Math.max(0, ...Object.values(latest.current.document.clips).map((item) => item.startFrame + item.durationFrames));
    }

    /**
     * Where a lane stands at the current frame: shown, waiting ahead of its start, or past its end.
     * @param lane - The lane.
     * @returns Its role, or null when its clip or source is gone.
     * @throws {never} Never.
     */
    function roleOf(lane: VideoLane): 'visible' | 'premount' | 'gone' | null {
      const found = videoLaneClip(latest.current.document, lane.clipId);
      if (found === null) return null;
      const { clip } = found;
      if (position.current < clip.startFrame) return 'premount';
      return position.current < clip.startFrame + clip.durationFrames ? 'visible' : 'gone';
    }

    /**
     * Whether a lane failed: its asset, or its element's error.
     * @param lane - The lane.
     * @returns Whether it failed.
     * @throws {never} Never.
     */
    function failed(lane: VideoLane): boolean {
      return lane.layer.state === 'failed' || lane.element.error !== null;
    }

    /**
     * The visible lanes that take part in playback: not failed.
     * @returns The lanes.
     * @throws {never} Never.
     */
    function activeLanes(): VideoLane[] {
      return controller.lanes().filter((lane) => roleOf(lane) === 'visible' && !failed(lane));
    }

    /**
     * The source time a lane shows at the current frame; its in-point while it waits ahead of its start.
     * @param lane - The lane.
     * @returns The source time, or null when its clip is gone.
     * @throws {never} Never.
     */
    function targetOf(lane: VideoLane): number | null {
      const found = videoLaneClip(latest.current.document, lane.clipId);
      if (found === null) return null;
      const { clip, source } = found;
      const frame = Math.min(clip.startFrame + clip.durationFrames - 1, Math.max(clip.startFrame, position.current));
      try {
        return timelineSourceSeconds(clip, source, latest.current.document.settings.fps, frame);
      } catch {
        return null;
      }
    }

    /**
     * Whether a lane's clip runs past its file at the current frame: it holds the file's last picture.
     * @param lane - The lane.
     * @returns Whether it is in its tail.
     * @throws {never} Never.
     */
    function inTail(lane: VideoLane): boolean {
      if (atFileEnd(lane.element)) return true;
      const target = targetOf(lane);
      return target !== null && Number.isFinite(lane.element.duration) && target > lane.element.duration;
    }

    /**
     * Ask a lane to show a source time. Within the tolerance of where it already is, it stays and counts as landed.
     * @param lane - The lane.
     * @param target - The source time.
     * @param tolerance - How far off it may stay unsought.
     * @throws {never} Never.
     */
    function place(lane: VideoLane, target: number, tolerance: number): void {
      lane.fresh = false;
      lane.target = target;
      lane.tailSeek = false;
      lane.lastDrift = null;
      const found = videoLaneClip(latest.current.document, lane.clipId);
      if (found !== null) lane.mapping = videoLaneMapping(found.clip);
      const element = lane.element;
      if (tolerance > 0 && element.readyState >= 1 && !element.seeking && Math.abs(element.currentTime - reachableTime(element, target)) <= tolerance) {
        lane.awaitingSeek = false;
        return;
      }
      lane.awaitingSeek = true;
      lane.seekAssigned = false;
    }

    /**
     * Send a lane's pending seek once it has metadata, and note when it has landed.
     * @param lane - The lane.
     * @throws {never} Never.
     */
    function advanceSeek(lane: VideoLane): void {
      const element = lane.element;
      if (!lane.awaitingSeek || element.readyState < 1 || lane.layer.fileUrl === null) return;
      try {
        if (!lane.seekAssigned) {
          lane.seekAssigned = true;
          if (element.currentTime !== lane.target) element.currentTime = lane.target;
        }
      } catch {
        return;
      }
      // Seek done: seeked, data for the frame, and within half a frame of the reachable target (#1410 design §6.3).
      if (!element.seeking && element.readyState >= 2 && Math.abs(element.currentTime - reachableTime(element, lane.target)) < halfFrame()) {
        lane.awaitingSeek = false;
      }
    }

    /**
     * Whether a visible lane can be shown and played from the current frame.
     * @param lane - The lane.
     * @returns Whether it is in place.
     * @throws {never} Never.
     */
    function ready(lane: VideoLane): boolean {
      const element = lane.element;
      if (lane.layer.state !== 'ready' || lane.layer.fileUrl === null || lane.fresh || lane.awaitingSeek) return false;
      if (inTail(lane)) {
        // At the file end HAVE_FUTURE_DATA is never reached (#1410 design §6.3).
        return atFileEnd(element) && (element.ended || element.readyState >= 2);
      }
      return element.readyState >= 3;
    }

    /**
     * Whether a lane is playing or holds its tail.
     * @param lane - The lane.
     * @returns Whether it needs no play().
     * @throws {never} Never.
     */
    function started(lane: VideoLane): boolean {
      return inTail(lane) || (!lane.element.paused && !lane.pendingPlay);
    }

    /**
     * Make every pending play() void and pause the lanes.
     * @param lanes - The lanes to stop.
     * @throws {never} Never.
     */
    function stop(lanes: readonly VideoLane[]): void {
      for (const lane of lanes) {
        lane.token += 1;
        lane.pendingPlay = false;
        if (!lane.element.paused) lane.element.pause();
      }
    }

    /**
     * The browser refused to play with sound: pause and say how to start (#1410 design §6.2).
     * @throws {never} Never.
     */
    function refusedByBrowser(): void {
      cancelFrame();
      anchor = null;
      boundaryAnchor = null;
      stop(controller.lanes());
      publish('pause', 'paused');
      host.reposition();
      setWebStates(host.states());
      toast.warning(t('timeline.preview.playBlocked'));
    }

    /**
     * Start a lane's element once; a settled play() is checked against the lane's current request (`media.js:142-152,
     * 519, 541-555`).
     * @param lane - The lane.
     * @throws {never} Never.
     */
    function requestPlay(lane: VideoLane): void {
      if (lane.pendingPlay) return;
      lane.pendingPlay = true;
      const token = lane.token;
      const element = lane.element;
      /**
       * Whether this request still stands.
       * @returns Whether the lane is current and nothing voided the request.
       * @throws {never} Never.
       */
      const current = (): boolean => active && lane.token === token && controller.element(lane.clipId) === element;
      try {
        void element.play().then(() => {
          if (!current()) {
            // A late start of an element nobody wants playing now is undone; a newer request owns the element.
            const wanted = active && controller.element(lane.clipId) === element && state.current.state === 'playing' && roleOf(lane) === 'visible';
            if (!lane.pendingPlay && !wanted) element.pause();
            return;
          }
          lane.pendingPlay = false;
          evaluate();
        }, (error: unknown) => {
          if (!current()) return;
          lane.pendingPlay = false;
          if (error instanceof DOMException && error.name === 'NotAllowedError') refusedByBrowser();
        });
      } catch {
        lane.pendingPlay = false;
      }
    }

    /**
     * Freeze the preview on the current frame: every lane pauses, the awaited lanes seek to the frame, and the other
     * lanes seek too when further off than the resume threshold (#1410 design §6.3, Remotion `get-media-sync-action.ts:126-137`).
     * @param awaited - The lanes the wait is for.
     * @throws {never} Never.
     */
    function freeze(awaited: readonly VideoLane[]): void {
      cancelFrame();
      anchor = null;
      boundaryAnchor = null;
      publish('play', 'waiting');
      const lanes = activeLanes();
      stop(lanes);
      for (const lane of lanes) {
        const target = targetOf(lane);
        if (target === null) continue;
        if (awaited.includes(lane)) place(lane, target, 0);
        else if (!inTail(lane) && !lane.awaitingSeek) place(lane, target, limits().resumeSeekSeconds);
      }
      for (const lane of awaited) if (!lanes.includes(lane)) {
        const target = targetOf(lane);
        if (target !== null) place(lane, target, 0);
      }
      for (const lane of lanes) advanceSeek(lane);
    }

    /**
     * Schedule one observation of the clock.
     * @throws {never} Never.
     */
    function schedule(): void {
      if (!active || frameHandle !== null || state.current.state !== 'playing' || anchor === null) return;
      frameHandle = requestAnimationFrame(tick);
    }

    /**
     * Steer or hard-sync each playing lane against the continuous clock, and hold lanes past their file end
     * (`media.js:193, 229, 234-249, 279-283, 410-413, 433-450, 479-481`).
     * @param now - The monotonic timestamp.
     * @returns The lanes to hard-sync.
     * @throws {never} Never.
     */
    function checkDrift(now: number): VideoLane[] {
      if (anchor === null) return [];
      const fps = latest.current.document.settings.fps;
      const seconds = anchor.frame * fps.den / fps.num + Math.max(0, now - anchor.at) / 1000;
      const { driftSteerSeconds, driftHardSyncSeconds, driftCatastrophicSeconds, driftSteerRate } = limits();
      const hard: VideoLane[] = [];
      for (const lane of activeLanes()) {
        const found = videoLaneClip(latest.current.document, lane.clipId);
        const element = lane.element;
        if (found === null || lane.awaitingSeek) continue;
        const target = videoLaneSourceSeconds(found.clip, found.source, fps, seconds);
        if (atFileEnd(element) || (Number.isFinite(element.duration) && target > element.duration)) {
          // The clip runs on past its file: hold the last picture, seeking to the end once when it lags.
          if (!atFileEnd(element) && !lane.tailSeek) {
            lane.tailSeek = true;
            element.currentTime = element.duration;
          }
          if (!element.paused) element.pause();
          continue;
        }
        if (lane.pendingPlay || element.paused) continue;
        const drift = element.currentTime - target;
        const jumped = lane.lastDrift !== null && Math.abs(drift - lane.lastDrift) > driftHardSyncSeconds;
        lane.lastDrift = drift;
        if (Math.abs(drift) > driftCatastrophicSeconds || (Math.abs(drift) > driftHardSyncSeconds && jumped)) {
          hard.push(lane);
          continue;
        }
        if (lane.steer !== 0 && (Math.abs(drift) < 0.01 || Math.sign(drift) === lane.steer)) lane.steer = 0;
        else if (lane.steer === 0 && Math.abs(drift) > driftSteerSeconds) lane.steer = drift < 0 ? 1 : -1;
        const rate = found.clip.rate.num / found.clip.rate.den * (1 + lane.steer * driftSteerRate);
        if (Math.abs(element.playbackRate - rate) > 1e-6) element.playbackRate = rate;
      }
      return hard;
    }

    /**
     * Advance to the next boundary or the sequence end, then check every lane.
     * @param now - The monotonic timestamp.
     * @throws {never} Never.
     */
    function tick(now: number): void {
      frameHandle = null;
      if (!active || state.current.intent !== 'play' || state.current.state !== 'playing' || anchor === null) return;
      const end = sequenceEnd();
      const fps = latest.current.document.settings.fps;
      const { document, readyClipIds } = latest.current;
      const stops = new Set<number>();
      for (const clip of Object.values(document.clips)) {
        if (!readyClipIds.has(clip.id)) continue;
        stops.add(clip.startFrame);
        // A web copy's instance can pass to another copy where it ends, so its end is checked too.
        if (clip.kind === 'web-animation') stops.add(clip.startFrame + clip.durationFrames);
      }
      // Where only videos end, the lanes left go on without stopping the clock.
      let boundary = nextTimelinePlaybackBoundary(document, readyClipIds, position.current, end);
      while (boundary < end && !stops.has(boundary)) boundary = nextTimelinePlaybackBoundary(document, readyClipIds, boundary, end);
      const next = Math.min(boundary, timelineFrameAt(anchor, now, fps, end));
      if (next >= end) {
        showFrame(Math.max(0, end - 1));
        stop(controller.lanes());
        anchor = null;
        sequenceEnded = true;
        publish('pause', 'paused');
        return;
      }
      if (next >= boundary) {
        // The visible layers change here; the render that shows this frame checks them and goes on from the instant
        // the clock reached the boundary, so the lanes that keep playing do not run ahead.
        boundaryAnchor = { frame: boundary, at: anchor.at + (boundary - anchor.frame) * 1000 * fps.den / fps.num };
        anchor = null;
        atBoundary.current = true;
        showFrame(next);
        return;
      }
      showFrame(next);
      const hard = checkDrift(now);
      if (hard.length > 0) {
        freeze(hard);
        return;
      }
      host.sendFrame();
      schedule();
    }

    /**
     * Read every lane and instance and move the transport on.
     * @throws {never} Never.
     */
    function evaluate(): void {
      if (!active) return;
      const states = controller.states();
      setVideoStates((previous) => (sameStates(previous, states) ? previous : states));
      if (!enabled) {
        stop(controller.lanes());
        cancelFrame();
        anchor = null;
        boundaryAnchor = null;
        publish('pause', 'paused');
        return;
      }
      for (const lane of controller.lanes()) {
        const role = roleOf(lane);
        if (role === 'gone' || role === null) {
          stop([lane]);
          continue;
        }
        if (lane.fresh) {
          const target = targetOf(lane);
          if (target !== null) place(lane, target, 0);
        }
        advanceSeek(lane);
        if (role === 'premount' && !lane.element.paused) stop([lane]);
      }
      if (state.current.intent === 'pause') {
        stop(controller.lanes());
        publish('pause', 'paused');
        return;
      }
      const lanes = activeLanes();
      const webReady = host.ready() && latest.current.webPending !== true;
      const waiting = lanes.filter((lane) => !ready(lane));
      if (state.current.state === 'playing') {
        if (waiting.length > 0 || !webReady) {
          // A lane ran dry, or a new layer at the boundary is not ready: hold this frame for it.
          freeze(waiting);
          return;
        }
        for (const lane of lanes) if (!inTail(lane) && lane.element.paused) requestPlay(lane);
        if (anchor === null && boundaryAnchor !== null) {
          anchor = boundaryAnchor;
          boundaryAnchor = null;
        }
        schedule();
        return;
      }
      publish('play', 'waiting');
      if (!webReady) {
        stop(lanes);
        return;
      }
      if (waiting.length > 0) return;
      for (const lane of lanes) if (!inTail(lane) && lane.element.paused) requestPlay(lane);
      if (lanes.every(started)) {
        anchor = { frame: position.current, at: performance.now() };
        boundaryAnchor = null;
        for (const lane of lanes) lane.lastDrift = null;
        publish('play', 'playing');
        schedule();
      }
    }

    /**
     * Ask every lane to show the current frame, within half a frame of where it is (#1410 design §6.3).
     * @throws {never} Never.
     */
    function placeAll(): void {
      for (const lane of controller.lanes()) {
        if (roleOf(lane) === 'gone' || failed(lane)) continue;
        const target = targetOf(lane);
        if (target !== null) place(lane, target, halfFrame());
      }
    }

    /**
     * Move to a frame the user picked and keep the play intent.
     * @param frame - The frame.
     * @throws {never} Never.
     */
    function seek(frame: number): void {
      if (!Number.isSafeInteger(frame)) return;
      cancelFrame();
      anchor = null;
      boundaryAnchor = null;
      sequenceEnded = false;
      showFrame(Math.max(0, Math.min(Math.max(0, sequenceEnd() - 1), frame)));
      repositionWeb();
      placeAll();
      const intent = state.current.intent;
      // The lanes already in place wait paused for the ones that seek.
      if (intent === 'play') stop(activeLanes().filter((lane) => !lane.awaitingSeek));
      publish(intent, intent === 'play' ? 'waiting' : 'paused');
      evaluate();
    }

    /**
     * Toggle the user's intent.
     * @throws {never} Never.
     */
    function toggle(): void {
      if (!enabled || sequenceEnd() === 0) return;
      if (state.current.intent === 'play') {
        cancelFrame();
        anchor = null;
        boundaryAnchor = null;
        stop(controller.lanes());
        publish('pause', 'paused');
        repositionWeb();
        placeAll();
        evaluate();
        return;
      }
      if (sequenceEnded) {
        publish('play', 'waiting');
        seek(0);
        return;
      }
      repositionWeb();
      placeAll();
      publish('play', 'waiting');
      evaluate();
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
     * Load one video lane again; it is then treated as newly visible (#1410 design §6.2).
     * @param clipId - The lane's clip.
     * @throws {never} Never.
     */
    function retryVideo(clipId: string): void {
      const lane = controller.lanes().find((item) => item.clipId === clipId);
      if (lane === undefined) return;
      if (lane.element.error !== null) {
        try {
          lane.element.load();
          controller.configure();
        } catch {
          evaluate();
          return;
        }
      }
      lane.token += 1;
      lane.pendingPlay = false;
      lane.fresh = true;
      if (state.current.state === 'playing') freeze([lane]);
      evaluate();
    }

    /**
     * React to a document change: a lane whose clip moved, changed in-point, speed or source is placed again, and
     * hard-synced while playing (#1410 design §6.3).
     * @throws {never} Never.
     */
    function placementChanged(): void {
      controller.configure();
      const moved = controller.lanes().filter((lane) => {
        const found = videoLaneClip(latest.current.document, lane.clipId);
        return !lane.fresh && found !== null && lane.mapping !== '' && lane.mapping !== videoLaneMapping(found.clip);
      });
      if (moved.length === 0) {
        evaluate();
        return;
      }
      if (state.current.state === 'playing') {
        freeze(moved);
      } else {
        for (const lane of moved) {
          const target = targetOf(lane);
          if (target !== null) place(lane, target, 0);
        }
      }
      evaluate();
    }

    actions.current = { toggle, seek, retryVideo, retryWeb, placementChanged };
    evaluateNow.current = evaluate;
    evaluate();
    return () => {
      active = false;
      evaluateNow.current = null;
      cancelFrame();
      stop(controller.lanes());
      actions.current = null;
    };
  }, [enabled, host, controller]);

  React.useEffect(() => () => {
    state.current = { intent: 'pause', state: 'paused' };
  }, []);

  // The bridge's replies arrive on the window; only the iframe of an attached instance is listened to. A hidden Space
  // tab runs no effects, so the stop detaches everything and showing it again attaches every instance with a new hello.
  React.useEffect(() => host.listen(), [host]);

  React.useEffect(() => {
    host.sync(webLayers);
    setWebStates(host.states());
    evaluateNow.current?.();
  }, [host, webLayers]);

  React.useEffect(() => {
    evaluateNow.current?.();
  }, [input.webPending]);

  React.useEffect(() => {
    actions.current?.placementChanged();
  }, [input.document]);

  React.useEffect(() => {
    if (!atBoundary.current) return;
    atBoundary.current = false;
    evaluateNow.current?.();
  }, [input.frame]);

  const toggle = React.useCallback((): void => actions.current?.toggle(), []);
  const seek = React.useCallback((frame: number): void => actions.current?.seek(frame), []);
  const retryVideo = React.useCallback((clipId: string): void => actions.current?.retryVideo(clipId), []);
  const retryWeb = React.useCallback((key: string): void => actions.current?.retryWeb(key), []);
  const videoElement = React.useCallback((clipId: string): HTMLVideoElement | undefined => controller.element(clipId), [controller]);
  return { ...snapshot, toggle, seek, videoStates, videoElement, retryVideo, webStates, retryWeb };
}
