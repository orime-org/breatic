// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The media lanes of the Timeline preview (#1410 design §6.2, inner#1709): one `<video>` per visible
 * or premounted video clip and one `<audio>` per audible or premounted sound clip, keyed by clip id. The controller owns
 * each element's lifecycle, its seek and play requests, its per-lane sync state and its node in the preview's audio
 * graph; the playback hook owns the clock and the `AudioContext`, and decides when lanes seek, play or wait.
 *
 * The sync rules are ported from the HyperFrames runtime (`@hyperframes/core` 0.8.186 `dist/runtime/media.js`,
 * Apache-2.0); each ported function names its source lines.
 */

import {
  TIMELINE_MAX_GAIN, type TimelineAudioClip, type TimelineAudioSource, type TimelineDocumentV1, type TimelineRate, type TimelineVideoClip,
  type TimelineVideoSource,
} from '@breatic/shared';
import { createVideoRenderer } from '@web/spaces/canvas/video-presentation/create-video-renderer';
import { runtimeSourceKeyOf, type VideoPresentationSource, type VideoRendererResource } from '@web/spaces/canvas/video-presentation/types';

import { corsUrl } from '@web/lib/cors-url';

/** One visible or premounted video or sound clip as the Space hands it over, read from the source the document holds. */
export interface TimelineMediaLayer {
  clipId: string;
  /** A `<video>` or an `<audio>`; a video by default. */
  kind?: 'video' | 'audio';
  /** The source's stored address, played while no version is selected; null while a selected version waits. */
  fileUrl: string | null;
  /** A video's selected version, played through the renderer the canvas uses (frames-split §7.14); null plays `fileUrl`. */
  presentation?: VideoPresentationSource | null;
  coverUrl: string | null;
  /** A selected version that cannot be read (its manifest failed): the layer fails, never falling back to the original. */
  failed?: boolean;
}

/** What a media layer's preview note shows. */
export type TimelineMediaLayerState = 'ready' | 'failed';

/** One media lane: an element and what the playback asked of it. */
export interface MediaLane {
  readonly clipId: string;
  readonly element: HTMLMediaElement;
  /** What sits in the frame: the element itself, or the renderer's host holding the composited picture. */
  readonly surface: HTMLElement;
  /** The renderer a selected version plays through, and whether it reported a failure. */
  renderer: VideoRendererResource | null;
  rendererFailed: boolean;
  layer: TimelineMediaLayer;
  /** Not placed yet since it entered, its file changed or it was retried; the playback seeks it to its target on the next check. */
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
  /** Its source and gain nodes while an `AudioContext` is attached. */
  audio: { source: MediaElementAudioSourceNode; gain: GainNode } | null;
}

/** The clip and its source a lane plays, read from the current document. */
export type MediaLaneClip = { clip: TimelineVideoClip; source: TimelineVideoSource } | { clip: TimelineAudioClip; source: TimelineAudioSource };

/** The media-layer controller the playback hook creates once. */
export interface MediaLayerController {
  /** Create the elements of layers that entered, update changed files and remove the elements of layers that left. */
  sync: (layers: readonly TimelineMediaLayer[]) => void;
  /** A clip's element. */
  element: (clipId: string) => HTMLMediaElement | undefined;
  /** What a clip places in the frame. */
  surface: (clipId: string) => HTMLElement | undefined;
  /** Start a failed renderer again; true when the lane had one to restart. */
  restartRenderer: (clipId: string) => boolean;
  /** Every lane, in the order the layers were handed over. */
  lanes: () => MediaLane[];
  /** Each lane's state for its preview note. */
  states: () => ReadonlyMap<string, TimelineMediaLayerState>;
  /** Apply each clip's speed, gain and mute again. */
  configure: () => void;
  /** Route every lane, and each lane made later, through its own gain node into this context. */
  attachAudio: (context: AudioContext) => void;
  /** Disconnect, release and remove every element. */
  dispose: () => void;
}

/** What the controller reads and reports. */
export interface MediaLayerControllerOptions {
  document: () => TimelineDocumentV1;
  /** Called when an element reports something the playback checks. */
  onChange: () => void;
  /** Makes a clip's element of the given kind. */
  createMedia: (clipId: string, kind: 'video' | 'audio') => HTMLMediaElement;
}

const MEDIA_EVENTS = [
  'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'play', 'pause', 'waiting', 'stalled',
  'seeked', 'seeking', 'timeupdate', 'ended', 'error',
] as const;

/**
 * The video or sound clip a lane plays and its source, when both are in the document.
 * @param document - The current document.
 * @param clipId - The lane's clip.
 * @returns The clip and source, or null.
 * @throws {never} Never.
 */
export function mediaLaneClip(document: TimelineDocumentV1, clipId: string): MediaLaneClip | null {
  const clip = document.clips[clipId];
  if (clip?.kind === 'video') {
    const source = document.sources[clip.sourceId];
    return source?.kind === 'video' ? { clip, source } : null;
  }
  if (clip?.kind === 'audio') {
    const source = document.sources[clip.sourceId];
    return source?.kind === 'audio' ? { clip, source } : null;
  }
  return null;
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
export function mediaLaneSourceSeconds(clip: MediaLaneClip['clip'], source: MediaLaneClip['source'], fps: TimelineRate, seconds: number): number {
  const inPoint = clip.sourceInFrame * source.timebase.den / source.timebase.num;
  return inPoint + (seconds - clip.startFrame * fps.den / fps.num) * clip.rate.num / clip.rate.den;
}

/**
 * The placement a lane is seeked for; a change means the lane must be placed again.
 * @param clip - The lane's clip.
 * @returns Its start, in-point, speed and source.
 * @throws {never} Never.
 */
export function mediaLaneMapping(clip: MediaLaneClip['clip']): string {
  return `${clip.startFrame}:${clip.sourceInFrame}:${clip.rate.num}/${clip.rate.den}:${clip.sourceId}`;
}

/**
 * Whether a lane failed: its selected version's manifest or renderer, or its element's error (#1410 design §6.2);
 * `networkState` 3 right after a new src is not a failure (`media.js:157-159` uses it only to skip one play()).
 * @param lane - The lane.
 * @returns Whether it failed.
 * @throws {never} Never.
 */
export function mediaLaneFailed(lane: MediaLane): boolean {
  // jsdom reports a missing error as undefined, the platform as null.
  return lane.layer.failed === true || lane.rendererFailed || Boolean(lane.element.error);
}

/**
 * The identity a lane plays: the selected version's runtime source key, or the original's address.
 * @param layer - The layer.
 * @returns The key; a change means a new lane.
 * @throws {never} Never.
 */
function playedKey(layer: TimelineMediaLayer): string {
  return layer.presentation == null ? 'original' : runtimeSourceKeyOf(layer.presentation);
}

/**
 * Create the controller.
 * @param options - What it reads and reports.
 * @returns The controller.
 * @throws {never} Never.
 */
export function createMediaLayerController(options: MediaLayerControllerOptions): MediaLayerController {
  const lanes = new Map<string, MediaLane>();
  let context: AudioContext | null = null;

  /**
   * Route a lane through its own gain node into the attached context.
   * @param lane - The lane.
   * @throws {DOMException} When the element already feeds another context.
   */
  function connect(lane: MediaLane): void {
    if (context === null || lane.audio !== null) return;
    const source = context.createMediaElementSource(lane.element);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    lane.audio = { source, gain };
  }

  /**
   * Take a lane's nodes out of the graph.
   * @param lane - The lane.
   * @throws {never} Never.
   */
  function disconnect(lane: MediaLane): void {
    if (lane.audio === null) return;
    lane.audio.source.disconnect();
    lane.audio.gain.disconnect();
    lane.audio = null;
  }

  /**
   * Apply the clip's speed, and its gain and mute to its gain node; the element itself plays at full volume (design §5.2).
   * @param lane - The lane.
   * @throws {DOMException} When the browser refuses a media setting.
   */
  function configureLane(lane: MediaLane): void {
    const found = mediaLaneClip(options.document(), lane.clipId);
    if (found === null) return;
    const rate = found.clip.rate.num / found.clip.rate.den;
    // `media.js:479-481`: a rate is written only when it differs.
    if (Math.abs(lane.element.playbackRate - rate) > 1e-6) lane.element.playbackRate = rate;
    lane.steer = 0;
    lane.element.volume = 1;
    lane.element.muted = false;
    if (lane.audio !== null) lane.audio.gain.gain.value = found.clip.mute ? 0 : Math.min(found.clip.gain, TIMELINE_MAX_GAIN);
  }

  /**
   * Give an element its file and cover.
   * @param lane - The lane.
   * @param layer - Its layer.
   * @throws {never} Never.
   */
  function attach(lane: MediaLane, layer: TimelineMediaLayer): void {
    // A selected version's renderer gives the element its playback file. Web Audio reads the samples only from a
    // CORS-mode response (design §5.2); a refused one is an element error.
    if (layer.presentation == null && layer.fileUrl !== null) {
      const src = corsUrl(layer.fileUrl);
      if (lane.element.src !== src) lane.element.src = src;
    }
    if (!(lane.element instanceof HTMLVideoElement)) return;
    if (layer.coverUrl !== null) lane.element.poster = layer.coverUrl;
    else lane.element.removeAttribute('poster');
  }

  /**
   * Stop one lane: its nodes leave the graph, then its element pauses, drops its file and is removed (design §7.4).
   * @param lane - The lane.
   * @throws {never} Never.
   */
  function remove(lane: MediaLane): void {
    lane.token += 1;
    lane.pendingPlay = false;
    for (const event of MEDIA_EVENTS) lane.element.removeEventListener(event, options.onChange);
    lanes.delete(lane.clipId);
    disconnect(lane);
    lane.element.pause();
    lane.renderer?.dispose();
    lane.renderer = null;
    lane.element.removeAttribute('src');
    lane.element.load();
    lane.element.remove();
    lane.surface.remove();
  }

  /**
   * Start the renderer of a lane playing a selected version, through the lane's own element.
   * @param lane - The lane.
   * @throws {never} Renderer failures are reported through its callbacks.
   */
  function render(lane: MediaLane): void {
    const source = lane.layer.presentation;
    if (source == null || !(lane.element instanceof HTMLVideoElement)) return;
    lane.rendererFailed = false;
    // Cleared when this renderer is released, so a late report from it cannot fail its successor.
    const life = { live: true };
    /**
     * Records a failure of this renderer while it is still the lane's.
     * @throws {never} Never.
     */
    const failed = (): void => { if (life.live && lanes.get(lane.clipId) === lane) { lane.rendererFailed = true; options.onChange(); } };
    const resource = createVideoRenderer(lane.surface, source, {
      ready: () => options.onChange(),
      frame: () => undefined,
      // The Timeline seeks through the element; no frame callback here is held to a seek.
      getSeekEpoch: () => 0,
      error: failed,
      contextLost: failed,
      contextRestored: () => undefined,
    }, lane.element);
    lane.renderer = { dispose: () => { life.live = false; resource.dispose(); } };
    // The renderer loads metadata only; a Timeline layer buffers ahead to play on cue.
    lane.element.preload = 'auto';
  }

  /**
   * Make a lane for a layer.
   * @param layer - The layer.
   * @returns The lane.
   * @throws {never} Never.
   */
  function create(layer: TimelineMediaLayer): MediaLane {
    const kind = layer.kind ?? 'video';
    const element = options.createMedia(layer.clipId, kind);
    element.setAttribute('data-clip-id', layer.clipId);
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    let surface: HTMLElement = element;
    if (kind === 'video' && layer.presentation != null) {
      surface = document.createElement('div');
      surface.setAttribute('data-clip-id', layer.clipId);
    }
    const lane: MediaLane = {
      clipId: layer.clipId, element, surface, renderer: null, rendererFailed: false, layer, fresh: true, target: 0, awaitingSeek: true, seekAssigned: false,
      pendingPlay: false, token: 0, steer: 0, lastDrift: null, tailSeek: false, mapping: '', audio: null,
    };
    attach(lane, layer);
    for (const event of MEDIA_EVENTS) element.addEventListener(event, options.onChange);
    lanes.set(layer.clipId, lane);
    render(lane);
    connect(lane);
    configureLane(lane);
    return lane;
  }

  return {
    sync(layers): void {
      const wanted = new Set(layers.map((layer) => layer.clipId));
      for (const lane of [...lanes.values()]) if (!wanted.has(lane.clipId)) remove(lane);
      const ordered = new Map<string, MediaLane>();
      for (const layer of layers) {
        let lane = lanes.get(layer.clipId);
        // Another version, or a version in place of the original, is another resource: a new lane (§7.8 Replace).
        if (lane !== undefined && playedKey(lane.layer) !== playedKey(layer)) { remove(lane); lane = undefined; }
        if (lane === undefined) {
          lane = create(layer);
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
    surface: (clipId) => lanes.get(clipId)?.surface,
    restartRenderer(clipId): boolean {
      const lane = lanes.get(clipId);
      if (lane === undefined || lane.layer.presentation == null) return false;
      if (lane.rendererFailed) { lane.renderer?.dispose(); render(lane); configureLane(lane); }
      return true;
    },
    lanes: () => [...lanes.values()],
    states(): ReadonlyMap<string, TimelineMediaLayerState> {
      const states = new Map<string, TimelineMediaLayerState>();
      for (const lane of lanes.values()) states.set(lane.clipId, mediaLaneFailed(lane) ? 'failed' : 'ready');
      return states;
    },
    configure(): void {
      for (const lane of lanes.values()) configureLane(lane);
    },
    attachAudio(next): void {
      context = next;
      for (const lane of lanes.values()) {
        connect(lane);
        configureLane(lane);
      }
    },
    dispose(): void {
      for (const lane of [...lanes.values()]) remove(lane);
      context = null;
    },
  };
}
