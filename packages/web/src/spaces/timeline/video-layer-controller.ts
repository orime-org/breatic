// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The video layers of the Timeline preview (#1410 design §6.2): one `<video>` per visible or premounted video clip,
 * keyed by clip id. The controller owns each element's lifecycle, its seek and play requests and its per-lane sync
 * state; the playback hook owns the clock and decides when lanes seek, play or wait.
 *
 * The sync rules are ported from the HyperFrames runtime (`@hyperframes/core` 0.8.186 `dist/runtime/media.js`,
 * Apache-2.0); each ported function names its source lines.
 */

import type { TimelineDocumentV1, TimelineRate, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';

/** One visible or premounted video clip as the Space hands it over, with its asset state. */
export interface TimelineVideoLayer {
  clipId: string;
  /** The file address once the asset is ready. */
  fileUrl: string | null;
  coverUrl: string | null;
  state: 'loading' | 'ready' | 'failed';
}

/** What a video layer's preview note shows. */
export type TimelineVideoLayerState = TimelineVideoLayer['state'];

/** One video lane: an element and what the playback asked of it. */
export interface VideoLane {
  readonly clipId: string;
  readonly element: HTMLVideoElement;
  layer: TimelineVideoLayer;
  /** Placed since it entered or its file changed; the playback seeks it to its target on the next check. */
  fresh: boolean;
  /** The source time the lane is to show, and whether it has not landed there yet. */
  target: number;
  awaitingSeek: boolean;
  seekAssigned: boolean;
  /** A `play()` not settled yet (`media.js:142-152`). */
  pendingPlay: boolean;
  /** Bumped whenever a pending `play()` stops mattering: a pause, a seek, a new file, a retry or removal. */
  token: number;
  /** The rate steering direction: 1 faster, -1 slower (`media.js:234-249`). */
  steer: -1 | 0 | 1;
  /** The drift at the previous check, for the jump test (`media.js:410-413`). */
  lastDrift: number | null;
  /** The one seek to the file end in the tail was sent (`media.js:279-283`). */
  tailSeek: boolean;
  /** The clip placement the lane was last placed for: start, in-point, speed and source. */
  mapping: string;
}

/** The clip and its source a lane plays, read from the current document. */
export interface VideoLaneClip { clip: TimelineVideoClip; source: TimelineVideoSource }

/** The video-layer controller the playback hook creates once. */
export interface VideoLayerController {
  /** Create the elements of layers that entered, update changed files and remove the elements of layers that left. */
  sync: (layers: readonly TimelineVideoLayer[]) => void;
  /** A clip's element. */
  element: (clipId: string) => HTMLVideoElement | undefined;
  /** Every lane, in the order the layers were handed over. */
  lanes: () => VideoLane[];
  /** Each lane's state for its preview note. */
  states: () => ReadonlyMap<string, TimelineVideoLayerState>;
  /** Apply each clip's speed, gain and mute to its element again. */
  configure: () => void;
  /** Pause and remove every element. */
  dispose: () => void;
}

/** What the controller reads and reports. */
export interface VideoLayerControllerOptions {
  document: () => TimelineDocumentV1;
  /** The current Timeline frame, for a lane's first placement. */
  frame: () => number;
  /** Called when an element reports something the playback checks. */
  onChange: () => void;
  /** Makes a clip's element; a `<video>` by default. */
  createMedia?: (clipId: string) => HTMLVideoElement;
}

const MEDIA_EVENTS = [
  'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'play', 'pause', 'waiting', 'stalled',
  'seeked', 'seeking', 'timeupdate', 'ended', 'error',
] as const;

/**
 * The clip a lane plays and its source, when both are in the document.
 * @param document - The current document.
 * @param clipId - The lane's clip.
 * @returns The video clip and source, or null.
 * @throws {never} Never.
 */
export function videoLaneClip(document: TimelineDocumentV1, clipId: string): VideoLaneClip | null {
  const clip = document.clips[clipId];
  if (clip?.kind !== 'video') return null;
  const source = document.sources[clip.sourceId];
  return source === undefined ? null : { clip, source };
}

/**
 * The source time a clip shows at a Timeline instant, measured on continuous time (#1410 design §6.2, `media.js:277`).
 * @param clip - The placement.
 * @param source - Its source.
 * @param fps - The Timeline frame rate.
 * @param seconds - The Timeline instant in seconds.
 * @returns The source time in seconds.
 * @throws {never} Never.
 */
export function videoLaneSourceSeconds(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate, seconds: number): number {
  const inPoint = clip.sourceInFrame * source.timebase.den / source.timebase.num;
  return inPoint + (seconds - clip.startFrame * fps.den / fps.num) * clip.rate.num / clip.rate.den;
}

/**
 * The placement a lane is seeked for; a change means the lane must be placed again.
 * @param clip - The lane's clip.
 * @returns Its start, in-point, speed and source.
 * @throws {never} Never.
 */
export function videoLaneMapping(clip: TimelineVideoClip): string {
  return `${clip.startFrame}:${clip.sourceInFrame}:${clip.rate.num}/${clip.rate.den}:${clip.sourceId}`;
}

/**
 * The time an element can reach for a target: its own end when the target lies past it.
 * @param element - The lane's element.
 * @param target - The requested source time.
 * @returns The reachable time.
 * @throws {never} Never.
 */
export function reachableTime(element: HTMLVideoElement, target: number): number {
  return Number.isFinite(element.duration) ? Math.min(target, element.duration) : target;
}

/**
 * Create the controller.
 * @param options - What it reads and reports.
 * @returns The controller.
 * @throws {never} Never.
 */
export function createVideoLayerController(options: VideoLayerControllerOptions): VideoLayerController {
  const lanes = new Map<string, VideoLane>();
  const listeners = new Map<string, EventListener>();

  /**
   * Apply the clip's speed, gain and mute.
   * @param lane - The lane.
   * @throws {DOMException} When the browser refuses a media setting.
   */
  function configureLane(lane: VideoLane): void {
    const found = videoLaneClip(options.document(), lane.clipId);
    if (found === null) return;
    const rate = found.clip.rate.num / found.clip.rate.den;
    // `media.js:479-481`: a rate is written only when it differs.
    if (Math.abs(lane.element.playbackRate - rate) > 1e-6) lane.element.playbackRate = rate;
    lane.steer = 0;
    lane.element.volume = Math.min(1, found.clip.gain);
    lane.element.muted = found.clip.mute;
  }

  /**
   * Give an element its file and cover.
   * @param lane - The lane.
   * @param layer - Its layer.
   * @throws {never} Never.
   */
  function attach(lane: VideoLane, layer: TimelineVideoLayer): void {
    if (layer.fileUrl !== null && lane.element.src !== layer.fileUrl) lane.element.src = layer.fileUrl;
    if (layer.coverUrl !== null) lane.element.poster = layer.coverUrl;
    else lane.element.removeAttribute('poster');
  }

  /**
   * Stop and detach one lane.
   * @param lane - The lane.
   * @throws {never} Never.
   */
  function remove(lane: VideoLane): void {
    lane.token += 1;
    lane.pendingPlay = false;
    const listener = listeners.get(lane.clipId);
    if (listener !== undefined) for (const event of MEDIA_EVENTS) lane.element.removeEventListener(event, listener);
    listeners.delete(lane.clipId);
    lanes.delete(lane.clipId);
    lane.element.pause();
    lane.element.remove();
  }

  return {
    sync(layers): void {
      const wanted = new Set(layers.map((layer) => layer.clipId));
      for (const lane of [...lanes.values()]) if (!wanted.has(lane.clipId)) remove(lane);
      const ordered = new Map<string, VideoLane>();
      for (const layer of layers) {
        let lane = lanes.get(layer.clipId);
        if (lane === undefined) {
          const element = options.createMedia?.(layer.clipId) ?? document.createElement('video');
          element.setAttribute('data-clip-id', layer.clipId);
          element.preload = 'auto';
          element.playsInline = true;
          lane = {
            clipId: layer.clipId, element, layer, fresh: true, target: 0, awaitingSeek: true, seekAssigned: false,
            pendingPlay: false, token: 0, steer: 0, lastDrift: null, tailSeek: false, mapping: '',
          };
          attach(lane, layer);
          configureLane(lane);
          const listener = options.onChange;
          for (const event of MEDIA_EVENTS) element.addEventListener(event, listener);
          listeners.set(layer.clipId, listener);
        } else {
          const fileChanged = layer.fileUrl !== null && layer.fileUrl !== lane.layer.fileUrl;
          const coverChanged = layer.coverUrl !== lane.layer.coverUrl;
          lane.layer = layer;
          if (fileChanged || coverChanged) attach(lane, layer);
          if (fileChanged) {
            // A new file starts the load algorithm again: the lane is placed afresh and its pending play() is void.
            lane.token += 1;
            lane.pendingPlay = false;
            lane.fresh = true;
            lane.awaitingSeek = true;
            lane.seekAssigned = false;
            lane.lastDrift = null;
            configureLane(lane);
          }
        }
        ordered.set(layer.clipId, lane);
      }
      lanes.clear();
      for (const [id, lane] of ordered) lanes.set(id, lane);
    },
    element: (clipId) => lanes.get(clipId)?.element,
    lanes: () => [...lanes.values()],
    states(): ReadonlyMap<string, TimelineVideoLayerState> {
      const states = new Map<string, TimelineVideoLayerState>();
      for (const lane of lanes.values()) {
        // A lane fails only on its asset or the element's error (#1410 design §6.2); `networkState` 3 right after a
        // new src is not a failure (`media.js:157-159` uses it only to skip one play()).
        states.set(lane.clipId, lane.layer.state === 'failed' || lane.element.error !== null ? 'failed' : lane.layer.state);
      }
      return states;
    },
    configure(): void {
      for (const lane of lanes.values()) configureLane(lane);
    },
    dispose(): void {
      for (const lane of [...lanes.values()]) remove(lane);
    },
  };
}
