// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Playback of the Timeline preview over every visible video layer (#1410 design §6). The hook creates one video-layer
 * controller that owns one element per visible or premounted video clip, keyed by clip id. The harness hands the hook
 * what the Space would: the visible and premounted video clips bottom-up with each clip's asset state and address,
 * and, through `createMedia`, the fake element the controller is to use for each clip.
 *
 * A fake element plays on as the test clock advances (at its own `playbackRate`, while not paused, seeking, ended or
 * short of data), so a lane in step with the clock has no drift; cases that need a drift place the element explicitly.
 */

import * as React from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineDocumentV1, TimelineTrack, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { toast } from '@web/lib/toast';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';

vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

type PlaybackInput = Parameters<typeof useTimelinePlayback>[0];
type PlaybackResult = ReturnType<typeof useTimelinePlayback> & { frame: number };
type AssetState = 'loading' | 'ready' | 'failed';

/** One visible or premounted video clip as the Space hands it to the playback (#1410 design §6.2). */
interface VideoLayerInput {
  clipId: string;
  fileUrl: string | null;
  coverUrl: string | null;
  state: AssetState;
}

interface MediaFacts {
  paused: boolean;
  currentTime: number;
  duration: number;
  seeking: boolean;
  ended: boolean;
  readyState: number;
  networkState: number;
  error: MediaError | null;
  playbackRate: number;
}

interface MediaFixture {
  element: HTMLVideoElement;
  facts: MediaFacts;
  play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
  load: ReturnType<typeof vi.fn<() => void>>;
  /** Every currentTime the element was given. */
  seeks: number[];
  /** Every playbackRate the element was given. */
  rateWrites: number[];
  /** Every src the element was given. */
  srcs: string[];
}

interface HarnessProps {
  document: TimelineDocumentV1;
  enabled: boolean;
  /** The element the controller gets for each video clip, by clip id; an unlisted clip gets a fresh ready one. */
  media: ReadonlyMap<string, MediaFixture>;
  /** Each video clip's asset state, by clip id; an unlisted clip is ready. */
  assets: Readonly<Record<string, AssetState>>;
  /** Each video clip's file address, by clip id; an unlisted clip has its default address. */
  urls: Readonly<Record<string, string>>;
  initialFrame: number;
}

interface DeferredPlay {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const HALF_FRAME = 1 / 48;
const ONE_FRAME = 1 / 24;
// `web_animation.preview_premount_ms` (2000, design §6.4) at 24 fps.
const PREMOUNT_FRAMES = 48;

const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video',
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: { num: 24, den: 1 },
  extentFrames: 240,
  durationSeconds: '10',
  durationOrigin: 'registered',
};
const SOURCE_B: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002', assetId: '20000000-0000-4000-8000-000000000002' };
const SOURCE_C: TimelineVideoSource = { ...SOURCE, id: '10000000-0000-4000-8000-000000000003', assetId: '20000000-0000-4000-8000-000000000003' };
const CLIP: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001',
  trackId: 'visual-1',
  kind: 'video',
  sourceId: SOURCE.id,
  startFrame: 0,
  sourceInFrame: 0,
  durationFrames: 240,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
// A second and third video stacked over CLIP for its whole span, as after the user shrinks the upper ones.
const LANE_B: TimelineVideoClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000012', trackId: 'v2', sourceId: SOURCE_B.id };
const LANE_C: TimelineVideoClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000013', trackId: 'v3', sourceId: SOURCE_C.id };
const TRACKS: TimelineTrack[] = [{ id: 'visual-1', kind: 'visual', order: 0 }, { id: 'v2', kind: 'visual', order: 1 }];
const THREE_TRACKS: TimelineTrack[] = [...TRACKS, { id: 'v3', kind: 'visual', order: 2 }];
// A file of 1.000 s under a clip of ceil(1.080 s x 24) = 26 frames: the clip's tail runs past the file's end.
const TAIL_SOURCE: TimelineVideoSource = { ...SOURCE, durationSeconds: '1.080', extentFrames: 26 };
const TAIL_CLIP: TimelineVideoClip = { ...CLIP, durationFrames: 26 };

let now = 0;
let nextFrameId = 0;
let queuedFrames = new Map<number, FrameRequestCallback>();
// Every fake element of the case, advanced as the test clock moves.
let fixtures: MediaFixture[] = [];

beforeEach(() => {
  now = 0;
  nextFrameId = 0;
  queuedFrames = new Map();
  fixtures = [];
  vi.clearAllMocks();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    queuedFrames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queuedFrames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  queuedFrames.clear();
});

/**
 * Create native media properties while retaining real DOM event dispatch.
 * @param overrides - The actual media conditions for the case, as they stand once the element has taken its src.
 * @returns The element and its controlled native observations.
 * @throws {Error} When a media property cannot be installed.
 */
function mediaFixture(overrides: Partial<MediaFacts> = {}): MediaFixture {
  const element = document.createElement('video');
  const facts: MediaFacts = {
    paused: true, currentTime: 0, duration: 10, seeking: false, ended: false,
    readyState: 4, networkState: 1, error: null, playbackRate: 1, ...overrides,
  };
  const seeks: number[] = [];
  const rateWrites: number[] = [];
  const srcs: string[] = [];
  let src = '';
  for (const key of ['paused', 'duration', 'seeking', 'ended', 'readyState', 'networkState', 'error'] as const) {
    Object.defineProperty(element, key, { configurable: true, get: () => facts[key] });
  }
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => facts.currentTime,
    set: (value: number) => {
      seeks.push(value);
      if (value !== facts.currentTime) facts.seeking = true;
      facts.currentTime = value;
    },
  });
  Object.defineProperty(element, 'playbackRate', {
    configurable: true,
    get: () => facts.playbackRate,
    set: (value: number) => {
      rateWrites.push(value);
      facts.playbackRate = value;
    },
  });
  // HTML load resets native facts and playbackRate; readiness remains at HAVE_NOTHING.
  const reset = (): void => {
    Object.assign(facts, { error: null, currentTime: 0, duration: Number.NaN, readyState: 0, paused: true, seeking: false, ended: false, playbackRate: 1 });
  };
  // Assigning a different src runs the load algorithm again; the first assignment is the one the case's facts describe.
  Object.defineProperty(element, 'src', {
    configurable: true,
    get: () => src,
    set: (value: string) => {
      srcs.push(value);
      if (src !== '' && value !== src) reset();
      src = value;
    },
  });
  const play = vi.fn<() => Promise<void>>(() => {
    facts.paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn<() => void>(() => {
    facts.paused = true;
  });
  const load = vi.fn<() => void>(reset);
  Object.defineProperty(element, 'play', { configurable: true, value: play });
  Object.defineProperty(element, 'pause', { configurable: true, value: pause });
  Object.defineProperty(element, 'load', { configurable: true, value: load });
  const fixture = { element, facts, play, pause, load, seeks, rateWrites, srcs };
  fixtures.push(fixture);
  return fixture;
}

/**
 * Capture a play request whose settlement is controlled by the test.
 * @returns The pending promise and its settlement functions.
 * @throws {never} Never.
 */
function deferredPlay(): DeferredPlay {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Build a complete persisted Timeline around the case's placements.
 * @param clips - The actual placements to preview.
 * @param sources - The immutable source records.
 * @param tracks - The visual tracks, the seeded main track by default.
 * @returns A versioned Timeline DTO.
 * @throws {never} Never.
 */
function timelineDocument(
  clips: TimelineVideoClip[] = [CLIP],
  sources: TimelineVideoSource[] = [SOURCE],
  tracks: TimelineTrack[] = [{ id: 'visual-1', kind: 'visual', order: 0 }],
): TimelineDocumentV1 {
  return {
    schemaVersion: 1,
    settings: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
    tracks: Object.fromEntries(tracks.map((track) => [track.id, track])),
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    sources: Object.fromEntries(sources.map((source) => [source.id, source])),
    operationReceipts: {},
  };
}

/**
 * The default file address of a clip's asset.
 * @param clipId - The clip.
 * @returns Its address.
 * @throws {never} Never.
 */
function urlOf(clipId: string): string {
  return `https://cdn.test/${clipId}.mp4`;
}

/**
 * The video layers the Space hands the playback at a frame: every ready video clip covering it or starting within the
 * premount lead after it, bottom-up by track order.
 * @param props - The case.
 * @param ready - The clips the arrangement resolved as ready.
 * @param frame - The current frame.
 * @returns The layers.
 * @throws {never} Never.
 */
function videoLayersAt(props: HarnessProps, ready: ReadonlySet<string>, frame: number): VideoLayerInput[] {
  const order = new Map(Object.values(props.document.tracks).map((track) => [track.id, track.order]));
  return Object.values(props.document.clips)
    .filter((clip): clip is TimelineVideoClip => clip.kind === 'video' && ready.has(clip.id) && order.has(clip.trackId)
      && frame < clip.startFrame + clip.durationFrames && frame >= clip.startFrame - PREMOUNT_FRAMES)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) || (a.id < b.id ? -1 : 1))
    .map((clip) => {
      const state = props.assets[clip.id] ?? 'ready';
      return { clipId: clip.id, fileUrl: state === 'ready' ? props.urls[clip.id] ?? urlOf(clip.id) : null, coverUrl: null, state };
    });
}

/**
 * Render controlled frame input with the current frame's video layers.
 * @param media - The element for CLIP, if the case names one.
 * @param overrides - The document, elements, asset states and Space state for the case.
 * @param strict - Whether React repeats the effect lifecycle.
 * @returns The hook, its input and observed frame writes.
 * @throws {Error} When rendering or the hook fails.
 */
function renderPlayback(
  media: MediaFixture | null,
  overrides: Partial<HarnessProps> = {},
  strict = false,
): RenderHookResult<PlaybackResult, HarnessProps> & { props: HarnessProps; observedFrames: number[] } {
  const props: HarnessProps = {
    document: timelineDocument(), enabled: true,
    media: new Map(media === null ? [] : [[CLIP.id, media]]),
    assets: {}, urls: {}, initialFrame: 0, ...overrides,
  };
  const observedFrames: number[] = [];
  const created = new Map<string, MediaFixture>();
  const hook = renderHook((input: HarnessProps): PlaybackResult => {
    const [frame, setFrame] = React.useState(input.initialFrame);
    const latest = React.useRef(input);
    latest.current = input;
    const onFrame = React.useCallback((value: number): void => {
      observedFrames.push(value);
      setFrame(value);
    }, []);
    const createMedia = React.useCallback((clipId: string): HTMLVideoElement => {
      const given = latest.current.media.get(clipId) ?? created.get(clipId) ?? mediaFixture();
      created.set(clipId, given);
      return given.element;
    }, []);
    // Mirrors TimelineSpace: readiness checks source ranges once per document; an unchanged layer set keeps its identity.
    const ready = React.useMemo(() => new Set(resolveTimelineArrangement(input.document).readyClipIds), [input.document]);
    const layersNow = videoLayersAt(input, ready, frame);
    const signature = JSON.stringify(layersNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer set changes only when its content does.
    const videoLayers = React.useMemo(() => layersNow, [signature]);
    const playbackInput: PlaybackInput = {
      document: input.document, readyClipIds: ready, frame, onFrame, videoLayers, createMedia, enabled: input.enabled,
    };
    return { ...useTimelinePlayback(playbackInput), frame };
  }, { initialProps: props, ...(strict ? { wrapper: React.StrictMode } : {}) });
  return { ...hook, props, observedFrames };
}

/**
 * Advance every playing fake element by the elapsed time at its own rate.
 * @param elapsedMs - The elapsed milliseconds.
 * @throws {never} Never.
 */
function advanceMedia(elapsedMs: number): void {
  if (elapsedMs <= 0) return;
  for (const { facts } of fixtures) {
    if (facts.paused || facts.seeking || facts.ended || facts.readyState < 3 || !Number.isFinite(facts.duration)) continue;
    facts.currentTime = Math.min(facts.duration, facts.currentTime + elapsedMs / 1000 * facts.playbackRate);
    if (facts.currentTime >= facts.duration) Object.assign(facts, { ended: true, paused: true });
  }
}

/**
 * Move the clock, let the elements play on, then run only the frame callbacks requested before this observation.
 * @param timestamp - The monotonic time to observe.
 * @param place - Sets element facts after they played on and before the callbacks run.
 * @throws {Error} When a frame callback fails.
 */
function tick(timestamp: number, place?: () => void): void {
  advanceMedia(timestamp - now);
  now = timestamp;
  place?.();
  const due = [...queuedFrames.values()];
  queuedFrames.clear();
  act(() => {
    for (const callback of due) callback(timestamp);
  });
}

/**
 * Observe the clock with some elements placed at given source times.
 * @param timestamp - The monotonic time.
 * @param positions - Each element and the source time it shows.
 * @throws {Error} When a frame callback fails.
 */
function at(timestamp: number, positions: ReadonlyArray<readonly [MediaFixture, number]>): void {
  tick(timestamp, () => {
    for (const [fixture, time] of positions) fixture.facts.currentTime = time;
  });
}

/**
 * Observe the clock in even steps up to a time, the elements playing on.
 * @param to - The last observation.
 * @param step - Milliseconds between observations.
 * @throws {Error} When a frame callback fails.
 */
function run(to: number, step = 50): void {
  while (now < to) tick(Math.min(to, now + step));
}

/**
 * Deliver a queued native event after changing the element's current facts.
 * @param fixture - The actual event target.
 * @param event - The native media event.
 * @param facts - The current properties read when the event is handled.
 * @throws {Error} When an event handler fails.
 */
function mediaEvent(fixture: MediaFixture, event: string, facts: Partial<MediaFacts> = {}): void {
  act(() => {
    Object.assign(fixture.facts, facts);
    fixture.element.dispatchEvent(new Event(event));
  });
}

/**
 * Flush media play promise settlement and React state updates.
 * @throws {Error} When an uncaught update fails.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * CLIP on the main track and LANE_B over it on v2, both ready and covering [0, 240).
 * @param b - LANE_B's element facts.
 * @param overrides - The case's other harness props.
 * @param laneB - LANE_B's placement.
 * @returns The hook and both elements.
 * @throws {Error} When rendering fails.
 */
function twoLanes(b: Partial<MediaFacts> = {}, overrides: Partial<HarnessProps> = {}, laneB: TimelineVideoClip = LANE_B): { hook: ReturnType<typeof renderPlayback>; a: MediaFixture; b: MediaFixture } {
  const a = mediaFixture();
  const upper = mediaFixture(b);
  const hook = renderPlayback(a, {
    document: timelineDocument([CLIP, laneB], [SOURCE, SOURCE_B], TRACKS),
    media: new Map([[CLIP.id, a], [laneB.id, upper]]), ...overrides,
  });
  return { hook, a, b: upper };
}

describe('useTimelinePlayback', () => {
  it('opens a ready video at rest', () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(hook.result.current.frame).toBe(0);
    expect(media.play).toHaveBeenCalledTimes(0);
  });

  it('holds the clock until a play request actually starts the element', async () => {
    const media = mediaFixture();
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
    await act(async () => {
      media.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(6);
  });

  it('confirms current media playback when its play promise settles', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('uses elapsed time through irregular frame callback intervals', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    const seekCount = media.seeks.length;
    for (const time of [8, 16, 50, 63, 121, 410, 1000]) tick(time);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.observedFrames.every(Number.isSafeInteger)).toBe(true);
    expect(media.seeks).toHaveLength(seekCount);
  });

  it('pauses immediately after a user pause', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    media.facts.currentTime = 1;
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.facts.paused).toBe(true);
    tick(4000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('seeks to the fixed source time while paused', () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.seek(48));
    expect(hook.result.current.frame).toBe(48);
    expect(media.facts.currentTime).toBe(2);
    mediaEvent(media, 'seeked', { seeking: false, readyState: 2 });
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.play).toHaveBeenCalledTimes(0);
  });

  it('pauses a playing lane for a user seek and plays it again once the seek lands (§6.3)', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    media.pause.mockClear();
    act(() => hook.result.current.seek(48));
    expect(hook.result.current.state).toBe('waiting');
    expect(media.facts.currentTime).toBe(2);
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.facts.paused).toBe(true);
    mediaEvent(media, 'seeked', { seeking: false, readyState: 4 });
    expect(media.play).toHaveBeenCalledTimes(2);
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('waits when readiness recovers before the requested seek completes', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    act(() => hook.result.current.seek(48));
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(48);
    mediaEvent(media, 'seeked', { seeking: false, paused: false });
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('freezes at the clock frame during buffering, realigns the stalled lane to it and rebases from it on recovery', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
    // The element has fallen behind the clock when it runs out of data.
    mediaEvent(media, 'waiting', { currentTime: 1.1, readyState: 2, paused: false });
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(media.seeks).toEqual([1.25]);
    tick(5000);
    expect(hook.result.current.frame).toBe(30);
    mediaEvent(media, 'seeked', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(media.facts.currentTime - 1.25)).toBeLessThan(HALF_FRAME);
    tick(5250);
    expect(hook.result.current.frame).toBe(36);
  });

  it('starts a paused native element when buffering recovers with play intent', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    mediaEvent(media, 'waiting', { readyState: 2, paused: true });
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'canplay', { readyState: 4 });
    await settle();
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('playing');
  });

  it('retains a user pause through a late buffering recovery', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    mediaEvent(media, 'waiting', { readyState: 2, currentTime: 1 });
    act(() => hook.result.current.toggle());
    mediaEvent(media, 'canplay', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.play).toHaveBeenCalledTimes(1);
    tick(5000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('keeps advancing when stalled still has sufficient native readiness', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    mediaEvent(media, 'stalled', { readyState: 4, paused: false });
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('holds the requested frame while its asset is loading and reports the layer loading', () => {
    const hook = renderPlayback(null, { assets: { [CLIP.id]: 'loading' } });
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('loading');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('waits while the current video element has no data yet', () => {
    const hook = renderPlayback(mediaFixture({ readyState: 0, networkState: 2 }));
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('starts the fixed frame once the current loading asset arrives', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media, { assets: { [CLIP.id]: 'loading' } });
    act(() => hook.result.current.toggle());
    tick(4000);
    hook.rerender({ ...hook.props, assets: {} });
    await settle();
    expect(media.element.src).toBe(urlOf(CLIP.id));
    expect(hook.result.current.state).toBe('playing');
    tick(4250);
    expect(hook.result.current.frame).toBe(6);
  });

  it('advances through a true Timeline gap to the next video boundary', async () => {
    const shifted = { ...CLIP, startFrame: 48 };
    const media = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(media, { document: timelineDocument([shifted]) });
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    tick(2000);
    await settle();
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('waiting');
    tick(4000);
    expect(hook.result.current.frame).toBe(48);
    mediaEvent(media, 'loadeddata', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(4250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('plays on into the next video at a clip boundary without stopping the clock once it premounted ready', async () => {
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: SOURCE_B.id, startFrame: 24, durationFrames: 24 };
    const mediaA = mediaFixture();
    const mediaB = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, SOURCE_B]),
      media: new Map([[first.id, mediaA], [second.id, mediaB]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    // Premounted ahead of its start, the next video gets its data while the first one plays.
    mediaEvent(mediaB, 'loadeddata', { readyState: 4, seeking: false });
    expect(mediaB.play).toHaveBeenCalledTimes(0);
    expect(mediaA.facts.paused).toBe(false);
    tick(1000);
    await settle();
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    expect(mediaB.play).toHaveBeenCalledTimes(1);
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.state).toBe('playing');
  });

  it('keeps a newer seek target when an old seek event reaches the current element', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    media.pause.mockClear();
    act(() => hook.result.current.seek(48));
    act(() => hook.result.current.seek(96));
    expect(media.pause).toHaveBeenCalled();
    expect(media.facts.paused).toBe(true);
    mediaEvent(media, 'seeked', { currentTime: 2, seeking: false });
    expect(hook.result.current.frame).toBe(96);
    expect(hook.result.current.state).toBe('waiting');
    expect(media.play).toHaveBeenCalledTimes(1);
    mediaEvent(media, 'seeked', { currentTime: 4, seeking: false });
    expect(media.play).toHaveBeenCalledTimes(2);
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(250);
    expect(hook.result.current.frame).toBe(102);
  });

  it('recomputes the current source time after a collaborative placement change', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    media.facts.currentTime = 1;
    hook.rerender({ ...hook.props, document: timelineDocument([{ ...CLIP, startFrame: 24 }]) });
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(media.facts.currentTime).toBe(0);
    mediaEvent(media, 'seeked', { currentTime: 0, seeking: false, paused: false, readyState: 4 });
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
  });

  it('advances through a gap after pausing the preceding video', async () => {
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: SOURCE_B.id, startFrame: 48, durationFrames: 24 };
    const mediaA = mediaFixture();
    const mediaB = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, SOURCE_B]),
      media: new Map([[first.id, mediaA], [second.id, mediaB]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    expect(mediaA.facts.paused).toBe(true);
    tick(1500);
    expect(hook.result.current.frame).toBe(36);
    tick(2000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('waiting');
  });

  it('keeps a late play promise from starting a lane whose file changed meanwhile', async () => {
    const media = mediaFixture();
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    hook.rerender({ ...hook.props, urls: { [CLIP.id]: 'https://cdn.test/replacement.mp4' } });
    expect(media.srcs.at(-1)).toBe('https://cdn.test/replacement.mp4');
    await act(async () => {
      media.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.state).toBe('waiting');
    expect(media.facts.paused).toBe(true);
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('keeps a late play promise from undoing a user pause', async () => {
    const media = mediaFixture();
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.toggle());
    await act(async () => {
      media.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.facts.paused).toBe(true);
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('keeps the AbortError of a play() that a file change interrupted from failing the lane', async () => {
    const media = mediaFixture();
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    hook.rerender({ ...hook.props, urls: { [CLIP.id]: 'https://cdn.test/replacement.mp4' } });
    await act(async () => {
      pending.reject(new DOMException('The play() request was interrupted by a new load request.', 'AbortError'));
      await Promise.resolve();
    });
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'loadeddata', { readyState: 4, duration: 10 });
    await settle();
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('playing');
    tick(250);
    expect(hook.result.current.frame).toBe(6);
  });

  it('pauses with a toast when play() is refused for sound, and plays on the next press', async () => {
    const { hook, a, b } = twoLanes();
    a.play.mockRejectedValueOnce(new DOMException('play() can only be initiated by a user gesture.', 'NotAllowedError'));
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
    expect(b.facts.paused).toBe(true);
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
    let calls: number[] = [];
    act(() => {
      hook.result.current.toggle();
      calls = [a.play.mock.calls.length, b.play.mock.calls.length];
    });
    expect(calls).toEqual([2, 2]);
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(6);
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1);
  });

  it('tries a play() rejected for another reason again on the next check, without failing the lane or pausing', async () => {
    const media = mediaFixture();
    media.play.mockRejectedValueOnce(new Error('Playback was refused'));
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'canplay', { readyState: 4 });
    await settle();
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(media.load).toHaveBeenCalledTimes(0);
    expect(hook.result.current.state).toBe('playing');
  });

  it('keeps the other lanes and the clock going at one lane\'s native error, and shows only that layer unavailable', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const pauses = a.pause.mock.calls.length;
    mediaEvent(b, 'error', { error: { code: 3, message: 'Decode failed' } as MediaError });
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('failed');
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    // A failed lane is out of the buffering check.
    mediaEvent(b, 'waiting', { readyState: 0 });
    expect(hook.result.current.state).toBe('playing');
    tick(2000);
    expect(hook.result.current.frame).toBe(48);
    expect(a.facts.paused).toBe(false);
    expect(a.pause).toHaveBeenCalledTimes(pauses);
  });

  it('keeps the other lanes and the clock going when one lane\'s asset fails', async () => {
    const { hook, a } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const pauses = a.pause.mock.calls.length;
    hook.rerender({ ...hook.props, assets: { [LANE_B.id]: 'failed' } });
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('failed');
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    tick(2000);
    expect(hook.result.current.frame).toBe(48);
    expect(a.facts.paused).toBe(false);
    expect(a.pause).toHaveBeenCalledTimes(pauses);
  });

  it('pauses a lane at once when its layer fails while playing, and keeps it paused through another lane\'s wait (§6.2)', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const playsB = b.play.mock.calls.length;
    hook.rerender({ ...hook.props, assets: { [LANE_B.id]: 'failed' } });
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('failed');
    expect(b.facts.paused).toBe(true);
    expect(a.facts.paused).toBe(false);
    tick(2000);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(48);
    expect(b.facts.paused).toBe(true);
    // The main lane runs dry: the wait and the resume after it leave the failed lane alone.
    mediaEvent(a, 'waiting', { currentTime: 1.9, readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(a.facts.paused).toBe(false);
    expect(b.facts.paused).toBe(true);
    expect(b.play).toHaveBeenCalledTimes(playsB);
  });

  it('pauses a hidden Space and keeps it paused when shown again', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    media.facts.currentTime = 1;
    hook.rerender({ ...hook.props, enabled: false });
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.facts.paused).toBe(true);
    tick(4000);
    expect(hook.result.current.frame).toBe(24);
    hook.rerender(hook.props);
    await settle();
    expect(hook.result.current.intent).toBe('pause');
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it('keeps a visible Space playing when the browser window loses focus', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('cleans up frames and media listeners on unmount', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const written = hook.observedFrames.length;
    hook.unmount();
    expect(media.facts.paused).toBe(true);
    expect(queuedFrames.size).toBe(0);
    mediaEvent(media, 'playing', { paused: false, readyState: 4 });
    tick(5000);
    expect(hook.observedFrames).toHaveLength(written);
  });

  it('recreates the active media lifecycle under React StrictMode', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media, {}, true);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    hook.unmount();
    expect(media.facts.paused).toBe(true);
    expect(queuedFrames.size).toBe(0);
  });

  it('holds the last partial source frame until the Timeline frame boundary', async () => {
    const shortSource = { ...SOURCE, durationSeconds: '1.01', extentFrames: 25 };
    const shortClip = { ...CLIP, durationFrames: 25 };
    const media = mediaFixture({ duration: 1.01 });
    const hook = renderPlayback(media, { document: timelineDocument([shortClip], [shortSource]) });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    now = 1010;
    mediaEvent(media, 'ended', { currentTime: 1.01, paused: true, ended: true });
    expect(hook.result.current.intent).toBe('play');
    tick(1040);
    expect(hook.result.current.frame).toBe(24);
    tick(1042);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(hook.result.current.frame).toBe(24);
  });

  it('holds the last frame when the registered duration is a little longer than the element plays', async () => {
    // The probe rounds the registered duration up; the element ends a fraction of a millisecond earlier.
    const shortSource = { ...SOURCE, durationSeconds: '1.012', extentFrames: 25 };
    const shortClip = { ...CLIP, durationFrames: 25 };
    const media = mediaFixture({ duration: 1.01 });
    const hook = renderPlayback(media, { document: timelineDocument([shortClip], [shortSource]) });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    now = 1010;
    mediaEvent(media, 'ended', { currentTime: 1.01, paused: true, ended: true });
    expect(hook.result.current.state).toBe('playing');
    tick(1042);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.frame).toBe(24);
  });

  it('holds the last frame when the element ends before the clip last frame starts, and plays on into the next clip', async () => {
    // The extent is ceil(1.012 s x 24) = 25 frames; the element ends at 0.9995 s, while frame 23 still shows.
    const shortSource = { ...SOURCE, durationSeconds: '1.012', extentFrames: 25 };
    const shortClip = { ...CLIP, durationFrames: 25 };
    const next = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: SOURCE_B.id, startFrame: 25, durationFrames: 24 };
    const media = mediaFixture({ duration: 0.9995 });
    const mediaB = mediaFixture();
    const hook = renderPlayback(media, {
      document: timelineDocument([shortClip, next], [shortSource, SOURCE_B]),
      media: new Map([[shortClip.id, media], [next.id, mediaB]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(990);
    expect(hook.result.current.frame).toBe(23);
    const before = hook.observedFrames.length;
    now = 999.5;
    mediaEvent(media, 'timeupdate', { currentTime: 0.9995, paused: true, ended: true });
    mediaEvent(media, 'pause');
    mediaEvent(media, 'ended');
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    tick(1020);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    tick(1042);
    await settle();
    expect(hook.result.current.frame).toBe(25);
    expect(Math.min(...hook.observedFrames.slice(before))).toBeGreaterThanOrEqual(23);
    expect(mediaB.play).toHaveBeenCalled();
    expect(hook.result.current.state).toBe('playing');
  });

  it('keeps the frame when paused while an ended element holds its last picture, and resumes from it', async () => {
    // The extent is ceil(1.012 s x 24) = 25 frames; the element ends at 0.9995 s, whose own frame is 23.
    const shortSource = { ...SOURCE, durationSeconds: '1.012', extentFrames: 25 };
    const shortClip = { ...CLIP, durationFrames: 25 };
    const next = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: SOURCE_B.id, startFrame: 25, durationFrames: 24 };
    const media = mediaFixture({ duration: 0.9995 });
    const mediaB = mediaFixture();
    const hook = renderPlayback(media, {
      document: timelineDocument([shortClip, next], [shortSource, SOURCE_B]),
      media: new Map([[shortClip.id, media], [next.id, mediaB]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(990);
    expect(hook.result.current.frame).toBe(23);
    now = 999.5;
    mediaEvent(media, 'timeupdate', { currentTime: 0.9995, paused: true, ended: true });
    mediaEvent(media, 'pause');
    mediaEvent(media, 'ended');
    tick(1020);
    expect(hook.result.current.frame).toBe(24);
    const before = hook.observedFrames.length;
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.frame).toBe(24);
    now = 2000;
    act(() => hook.result.current.toggle());
    expect(hook.result.current.frame).toBe(24);
    tick(2042);
    await settle();
    expect(hook.result.current.frame).toBe(25);
    expect(Math.min(...hook.observedFrames.slice(before))).toBeGreaterThanOrEqual(24);
  });

  it('plays from a seek to a frame whose source time lies past the element end', async () => {
    // The extent is ceil(1.080 s x 24) = 26 frames; frame 25 samples 1.0417 s, and the element clamps to its 1.000 s end.
    const shortSource = { ...SOURCE, durationSeconds: '1.080', extentFrames: 26 };
    const shortClip = { ...CLIP, durationFrames: 26 };
    const media = mediaFixture({ duration: 1 });
    const hook = renderPlayback(media, { document: timelineDocument([shortClip], [shortSource]) });
    act(() => hook.result.current.seek(25));
    expect(media.seeks.at(-1)).toBeCloseTo(25 / 24, 6);
    mediaEvent(media, 'seeked', { currentTime: 1, seeking: false, paused: true, ended: true });
    expect(hook.result.current.frame).toBe(25);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    tick(42);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
  });

  it('plays from a seek into the tail when the element at its end reports readyState 2', async () => {
    // At the end of the file HAVE_FUTURE_DATA is never reached; an element within 1 ms of its end counts as in place.
    const media = mediaFixture({ duration: 1 });
    const hook = renderPlayback(media, { document: timelineDocument([TAIL_CLIP], [TAIL_SOURCE]) });
    act(() => hook.result.current.seek(25));
    mediaEvent(media, 'seeked', { currentTime: 1, seeking: false, paused: true, ended: true, readyState: 2 });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    expect(media.play).toHaveBeenCalledTimes(0);
  });

  // A file of 1.013 s under TAIL_CLIP: frame 24 samples 1.000 s, within half a frame of the end yet 13 ms short of it;
  // frame 25 samples 1.0417 s, past the end. A tail lane is in place only within 1 ms of its end (#1410 design §6.3).
  const NEAR_END_SECONDS = 1.013;

  it('seeks a paused lane within half a frame of its file end on to the end at a seek into the tail, and plays to the sequence end once it lands (§6.3, §9.1)', async () => {
    const media = mediaFixture({ duration: NEAR_END_SECONDS });
    const hook = renderPlayback(media, { document: timelineDocument([TAIL_CLIP], [TAIL_SOURCE]) });
    act(() => hook.result.current.seek(24));
    mediaEvent(media, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(media.facts.currentTime).toBe(1);
    const sought = media.seeks.length;
    act(() => hook.result.current.seek(25));
    act(() => hook.result.current.toggle());
    await settle();
    expect(media.seeks.slice(sought)).toHaveLength(1);
    expect(media.seeks.at(-1)).toBeGreaterThanOrEqual(NEAR_END_SECONDS - 0.001);
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'seeked', { seeking: false, currentTime: NEAR_END_SECONDS, readyState: 2 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(25);
    tick(now + 42);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
  });

  it.each([
    ['reports data at its end', { readyState: 2 }],
    ['clamps the seek to its end and reports ended', { ended: true, paused: true, readyState: 2 }],
  ] as const)('seeks a playing lane within half a frame of its file end on to the end at a seek into the tail when it %s, and plays on to the sequence end (§6.3)', async (_name, landed) => {
    const media = mediaFixture({ duration: NEAR_END_SECONDS });
    const hook = renderPlayback(media, { document: timelineDocument([TAIL_CLIP], [TAIL_SOURCE]) });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(media.facts.currentTime).toBe(1);
    const sought = media.seeks.length;
    act(() => hook.result.current.seek(25));
    await settle();
    expect(media.seeks.slice(sought)).toHaveLength(1);
    expect(media.seeks.at(-1)).toBeGreaterThanOrEqual(NEAR_END_SECONDS - 0.001);
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'seeked', { seeking: false, currentTime: NEAR_END_SECONDS, ...landed });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(25);
    tick(now + 42);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
  });

  it('sends no seek at a seek into the tail when the playing lane is already within 1 ms of its file end, and plays on (§6.3)', async () => {
    const media = mediaFixture({ duration: NEAR_END_SECONDS });
    const hook = renderPlayback(media, { document: timelineDocument([TAIL_CLIP], [TAIL_SOURCE]) });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1012.5);
    expect(hook.result.current.frame).toBe(24);
    expect(media.facts.currentTime).toBeCloseTo(1.0125, 6);
    const sought = media.seeks.length;
    act(() => hook.result.current.seek(25));
    await settle();
    expect(media.seeks.slice(sought)).toEqual([]);
    expect(hook.result.current.state).toBe('playing');
    tick(now + 42);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
  });

  it('waits for a lane still seeking from an earlier request at a seek into the tail, and plays once it lands at its file end (§6.3)', async () => {
    const media = mediaFixture({ duration: NEAR_END_SECONDS });
    const hook = renderPlayback(media, { document: timelineDocument([TAIL_CLIP], [TAIL_SOURCE]) });
    act(() => hook.result.current.seek(24));
    expect(media.facts.seeking).toBe(true);
    act(() => hook.result.current.seek(25));
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    // The browser runs only the latest seek and reports one seeked, clamped to the end.
    mediaEvent(media, 'seeked', { seeking: false, currentTime: NEAR_END_SECONDS, ended: true, paused: true, readyState: 2 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(25);
    tick(now + 42);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
  });

  it('plays the final frame bucket before stopping at the sequence end', async () => {
    const media = mediaFixture({ duration: 1 });
    const hook = renderPlayback(media, { document: timelineDocument([{ ...CLIP, durationFrames: 24 }]) });
    act(() => hook.result.current.toggle());
    await settle();
    tick(959);
    expect(hook.result.current.frame).toBe(23);
    expect(hook.result.current.intent).toBe('play');
    tick(999);
    expect(hook.result.current.intent).toBe('play');
    tick(1000);
    expect(hook.result.current.frame).toBe(23);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.facts.paused).toBe(true);
  });
});

describe('useTimelinePlayback review regressions', () => {
  it.each([0, 30, 120])('continues the playing clock after seeking to frame %i inside the same gap', (target) => {
    const hook = renderPlayback(null, { document: timelineDocument([{ ...CLIP, startFrame: 240 }]) });
    act(() => hook.result.current.toggle());
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    act(() => hook.result.current.seek(target));
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(target + 6);
    expect(hook.result.current.state).toBe('playing');
  });

  it('keeps a paused gap seek at rest until the user explicitly resumes', () => {
    const hook = renderPlayback(null, { document: timelineDocument([{ ...CLIP, startFrame: 240 }]) });
    act(() => hook.result.current.toggle());
    tick(1000);
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.seek(30));
    tick(4000);
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    act(() => hook.result.current.toggle());
    tick(4250);
    expect(hook.result.current.frame).toBe(36);
  });

  it('crosses consecutive conflict intervals and holds the next ready video until its native seek completes', async () => {
    const conflicts = [24, 48, 96, 120].map((startFrame, index) => ({
      ...CLIP, id: `30000000-0000-4000-8000-00000000000${index + 1}`, startFrame, durationFrames: 48,
    }));
    const later = { ...CLIP, id: '30000000-0000-4000-8000-000000000005', startFrame: 192, durationFrames: 24, sourceInFrame: 24 };
    const document = timelineDocument([...conflicts, later]);
    expect(resolveTimelineArrangement(document).readyClipIds).toEqual([later.id]);
    const media = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(media, { document, media: new Map([[later.id, media]]) });
    act(() => hook.result.current.toggle());
    for (let second = 1; second <= 7; second += 1) {
      tick(second * 1000);
      expect(hook.result.current.frame).toBe(second * 24);
      expect(hook.result.current.state).toBe('playing');
      expect(media.play).toHaveBeenCalledTimes(0);
    }
    tick(8000);
    expect(hook.result.current.frame).toBe(192);
    expect(hook.result.current.state).toBe('waiting');
    tick(12000);
    expect(hook.result.current.frame).toBe(192);
    mediaEvent(media, 'loadedmetadata', { readyState: 1 });
    expect(media.facts.currentTime).toBe(1);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    expect(hook.result.current.state).toBe('waiting');
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'seeked', { seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(12250);
    expect(hook.result.current.frame).toBe(198);
    tick(13000);
    expect(hook.result.current.frame).toBe(215);
    expect(hook.result.current.intent).toBe('pause');
  });

  it.each([0, 4])('stops an arbitrarily late gap frame at the first ready source barrier with readyState %i', async (readyState) => {
    const clip = { ...CLIP, startFrame: 48, durationFrames: 24, sourceInFrame: 24 };
    const media = mediaFixture({ readyState });
    const hook = renderPlayback(media, { document: timelineDocument([clip]) });
    act(() => hook.result.current.toggle());
    tick(10000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(media.play).toHaveBeenCalledTimes(0);
    tick(30000);
    expect(hook.result.current.frame).toBe(48);
    if (readyState === 0) mediaEvent(media, 'loadedmetadata', { readyState: 1 });
    expect(media.facts.currentTime).toBe(1);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'seeked', { seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(30250);
    expect(hook.result.current.frame).toBe(54);
    tick(31000);
    expect(hook.result.current.frame).toBe(71);
    expect(hook.result.current.state).toBe('paused');
  });

  it('reloads only the retried lane and restores its source position, rate, gain and mute before native playback', async () => {
    const clip = { ...CLIP, rate: { num: 2, den: 1 }, durationFrames: 96, sourceInFrame: 24, gain: 0.4, mute: true };
    const media = mediaFixture({ readyState: 0, error: { code: 4, message: 'Media unavailable' } as MediaError });
    const hook = renderPlayback(media, { document: timelineDocument([clip]), initialFrame: 48 });
    expect(hook.result.current.videoStates.get(clip.id)).toBe('failed');
    act(() => hook.result.current.toggle());
    // A failed lane does not hold the clock.
    expect(hook.result.current.state).toBe('playing');
    act(() => hook.result.current.retryVideo(clip.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(media.srcs).toEqual([urlOf(clip.id)]);
    expect(media.facts.error).toBeNull();
    expect(media.facts.currentTime).toBe(0);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    // Queued events from before load must read the reset facts rather than release the new barrier.
    mediaEvent(media, 'canplay');
    mediaEvent(media, 'seeked');
    tick(4000);
    expect(hook.result.current.frame).toBe(48);
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'loadedmetadata', { readyState: 1, duration: 10 });
    expect(media.facts.currentTime).toBe(5);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'seeked', { seeking: false, readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'canplay', { readyState: 4 });
    await settle();
    expect(media.element.playbackRate).toBe(2);
    expect(media.element.volume).toBe(0.4);
    expect(media.element.muted).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.videoStates.get(clip.id)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    tick(4250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('keeps a lane whose reload threw failed until another explicit retry completes the readiness barriers', async () => {
    const nativeError = { code: 2, message: 'Network failed' } as MediaError;
    const media = mediaFixture({ readyState: 0, error: nativeError });
    media.load.mockImplementationOnce(() => { throw new DOMException('Reload unavailable', 'NotSupportedError'); });
    const hook = renderPlayback(media, { initialFrame: 48 });
    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(media.facts.error).toBe(nativeError);
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('failed');
    expect(hook.result.current.state).toBe('paused');
    expect(hook.result.current.intent).toBe('pause');
    expect(media.facts.paused).toBe(true);
    expect(queuedFrames.size).toBe(0);
    tick(1000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.observedFrames).toEqual([]);
    expect(media.play).toHaveBeenCalledTimes(0);

    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(2);
    expect(media.facts.error).toBeNull();
    // A retry keeps the user's intent.
    expect(hook.result.current.intent).toBe('pause');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    tick(4000);
    expect(hook.result.current.frame).toBe(48);
    mediaEvent(media, 'loadedmetadata', { readyState: 1, duration: 10 });
    expect(media.facts.currentTime).toBe(2);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'seeked', { readyState: 2, seeking: false });
    expect(hook.result.current.state).toBe('waiting');
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'canplay', { readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(media.play).toHaveBeenCalledTimes(1);
    tick(4250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('preserves a user pause through metadata and seek completion after a lane reload', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const hook = renderPlayback(media, { initialFrame: 48 });
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.toggle());
    mediaEvent(media, 'loadedmetadata', { readyState: 1, duration: 10 });
    expect(media.facts.currentTime).toBe(2);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: true });
    mediaEvent(media, 'seeked', { seeking: false });
    await settle();
    tick(5000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(media.facts.paused).toBe(true);
    expect(media.play).toHaveBeenCalledTimes(0);
  });

  it('uses the latest explicit seek during a lane reload and refuses the old source position', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const hook = renderPlayback(media, { initialFrame: 48 });
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.seek(96));
    mediaEvent(media, 'loadedmetadata', { readyState: 1, duration: 10 });
    expect(media.facts.currentTime).toBe(4);
    mediaEvent(media, 'seeked', { readyState: 4, currentTime: 2, seeking: false });
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(96);
    expect(media.play).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'seeked', { readyState: 2, currentTime: 4, seeking: false });
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'canplay', { readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(102);
  });

  it.each(['resolve', 'reject'] as const)('ignores an old play promise %s after a lane reload starts a newer play request', async (outcome) => {
    const media = mediaFixture();
    const previous = deferredPlay();
    const current = deferredPlay();
    media.play.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    mediaEvent(media, 'error', { readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    mediaEvent(media, 'loadedmetadata', { readyState: 1, duration: 10 });
    mediaEvent(media, 'canplay', { readyState: 4, seeking: false });
    expect(media.play).toHaveBeenCalledTimes(2);
    const pausesBeforeOldSettlement = media.pause.mock.calls.length;
    await act(async () => {
      if (outcome === 'resolve') previous.resolve();
      else previous.reject(new DOMException('Old load aborted playback', 'AbortError'));
      await Promise.resolve();
    });
    expect(media.pause).toHaveBeenCalledTimes(pausesBeforeOldSettlement);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    tick(4000);
    expect(hook.result.current.frame).toBe(0);
    await act(async () => {
      media.facts.paused = false;
      current.resolve();
      await current.promise;
    });
    expect(hook.result.current.state).toBe('playing');
    tick(4250);
    expect(hook.result.current.frame).toBe(6);
  });

  it('keeps a reloaded lane\'s late promise and old events from changing the lane that replaces it', async () => {
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: SOURCE_B.id, startFrame: 24, durationFrames: 24 };
    const mediaA = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const mediaB = mediaFixture({ readyState: 0 });
    const pending = deferredPlay();
    mediaA.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, SOURCE_B]),
      media: new Map([[first.id, mediaA], [second.id, mediaB]]),
    });
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.retryVideo(first.id));
    expect(mediaA.load).toHaveBeenCalledTimes(1);
    mediaEvent(mediaA, 'loadeddata', { readyState: 4, seeking: false, duration: 10 });
    expect(mediaA.play).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.seek(24));
    await act(async () => {
      mediaA.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    mediaEvent(mediaA, 'canplay', { readyState: 4 });
    expect(mediaA.facts.paused).toBe(true);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(mediaB.play).toHaveBeenCalledTimes(0);
    expect(mediaB.load).toHaveBeenCalledTimes(0);
    mediaEvent(mediaB, 'loadeddata', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(250);
    expect(hook.result.current.frame).toBe(30);
  });

  it('releases a lane-reload play request on unmount without late clock or listener activity', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    act(() => hook.result.current.retryVideo(CLIP.id));
    expect(media.load).toHaveBeenCalledTimes(1);
    mediaEvent(media, 'loadeddata', { readyState: 4, seeking: false, duration: 10 });
    expect(media.play).toHaveBeenCalledTimes(1);
    const writes = hook.observedFrames.length;
    hook.unmount();
    await act(async () => {
      media.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    mediaEvent(media, 'canplay', { readyState: 4, seeking: false });
    tick(5000);
    expect(media.facts.paused).toBe(true);
    expect(queuedFrames.size).toBe(0);
    expect(hook.observedFrames).toHaveLength(writes);
    expect(media.load).toHaveBeenCalledTimes(1);
  });
});

describe('useTimelinePlayback across layers (inner#1708 E22)', () => {
  const UPPER: TimelineVideoClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', trackId: 'v2', sourceId: SOURCE_B.id, startFrame: 48, durationFrames: 48 };

  /**
   * A lower clip over [0, 240) on the main track and an upper clip over [48, 96) on v2.
   * @returns The hook and both media elements, the upper one still loading.
   * @throws {Error} When rendering fails.
   */
  function layered(): { hook: ReturnType<typeof renderPlayback>; lower: MediaFixture; upper: MediaFixture } {
    const lower = mediaFixture();
    const upper = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(lower, {
      document: timelineDocument([CLIP, UPPER], [SOURCE, SOURCE_B], TRACKS),
      media: new Map([[CLIP.id, lower], [UPPER.id, upper]]),
    });
    return { hook, lower, upper };
  }

  it('freezes at the upper clip\'s start frame while the lower clip plays and waits for it to be ready', async () => {
    const { hook, lower, upper } = layered();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    tick(2000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(lower.facts.paused).toBe(true);
    tick(5000);
    expect(hook.result.current.frame).toBe(48);
    mediaEvent(upper, 'loadeddata', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(5250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('stops at the upper clip\'s start even when one frame callback jumps past the whole upper clip', async () => {
    const { hook, upper } = layered();
    act(() => hook.result.current.toggle());
    await settle();
    tick(10000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('waiting');
    expect(upper.play).toHaveBeenCalledTimes(0);
  });

  it('keeps the lower clip playing through the upper clip\'s end, with no wait and the clock continuous', async () => {
    const { hook, lower, upper } = layered();
    act(() => hook.result.current.toggle());
    await settle();
    tick(2000);
    mediaEvent(upper, 'loadeddata', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    const pauses = lower.pause.mock.calls.length;
    const seeks = lower.seeks.length;
    // The upper clip ends at frame 96, reached at 4000 ms.
    tick(4010);
    expect(hook.result.current.frame).toBe(96);
    expect(hook.result.current.state).toBe('playing');
    expect(upper.facts.paused).toBe(true);
    expect(lower.facts.paused).toBe(false);
    expect(lower.pause).toHaveBeenCalledTimes(pauses);
    expect(lower.seeks).toHaveLength(seeks);
    tick(4250);
    expect(hook.result.current.frame).toBe(102);
  });

  it('crosses a lower clip edge under a covering upper clip onto the next lower clip\'s own element, with the clock continuous (inner#1708 C2)', async () => {
    const M1: TimelineVideoClip = { ...CLIP, durationFrames: 48 };
    const M2: TimelineVideoClip = { ...CLIP, id: '30000000-0000-4000-8000-000000000009', startFrame: 48, sourceInFrame: 48, durationFrames: 192 };
    const COVER: TimelineVideoClip = { ...UPPER, startFrame: 0, durationFrames: 240 };
    const lower1 = mediaFixture();
    // Premounted at its in-point.
    const lower2 = mediaFixture({ currentTime: 2 });
    const upper = mediaFixture();
    const hook = renderPlayback(upper, {
      document: timelineDocument([M1, M2, COVER], [SOURCE, SOURCE_B], TRACKS),
      media: new Map([[M1.id, lower1], [M2.id, lower2], [COVER.id, upper]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    const pausesWhilePlaying = upper.pause.mock.calls.length;
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    tick(2010);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('playing');
    expect(lower2.play).toHaveBeenCalledTimes(1);
    expect(lower1.facts.paused).toBe(true);
    tick(3000);
    expect(hook.result.current.frame).toBe(72);
    expect(hook.result.current.state).toBe('playing');
    expect(upper.facts.paused).toBe(false);
    expect(upper.pause).toHaveBeenCalledTimes(pausesWhilePlaying);
  });

  it('treats a clip outside its source as not ready and plays through it as a gap', () => {
    const outside = { ...CLIP, id: '30000000-0000-4000-8000-000000000003', startFrame: 24, durationFrames: 24, sourceInFrame: 230 };
    const later = { ...CLIP, id: '30000000-0000-4000-8000-000000000004', startFrame: 96, durationFrames: 24, sourceInFrame: 24 };
    const document = timelineDocument([outside, later]);
    expect(resolveTimelineArrangement(document).readyClipIds).toEqual([later.id]);
    const media = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(media, { document, media: new Map([[later.id, media]]) });
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    tick(2000);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('playing');
    tick(5000);
    expect(hook.result.current.frame).toBe(96);
    expect(hook.result.current.state).toBe('waiting');
  });
});

describe('several video layers playing together (#1410 design §6.3)', () => {
  it('plays every visible video together without seeking lanes already in place', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(a.seeks).toEqual([]);
    expect(b.seeks).toEqual([]);
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(a.facts.paused).toBe(false);
    expect(b.facts.paused).toBe(false);
    expect(a.element.getAttribute('data-clip-id')).toBe(CLIP.id);
    expect(b.element.getAttribute('data-clip-id')).toBe(LANE_B.id);
  });

  it('calls play() on every element before toggle() returns when no web copy is visible and every lane is in place', () => {
    const { hook, a, b } = twoLanes();
    let calls: number[] = [];
    act(() => {
      hook.result.current.toggle();
      calls = [a.play.mock.calls.length, b.play.mock.calls.length];
    });
    expect(calls).toEqual([1, 1]);
  });

  it('on a user seek moves only the lanes more than half a frame off, and waits for them to land', async () => {
    const { hook, a, b } = twoLanes();
    // Frame 48 samples 2 s: the main lane is 0.01 s off, inside half a frame; the upper one is 2 s off.
    a.facts.currentTime = 2.01;
    act(() => hook.result.current.seek(48));
    expect(a.seeks).toEqual([]);
    expect(b.seeks).toEqual([2]);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    expect(a.play).toHaveBeenCalledTimes(0);
    tick(1000);
    expect(hook.result.current.frame).toBe(48);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(a.seeks).toEqual([]);
    tick(1250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('pauses every lane at a user seek while playing, holds a lane that landed first, and plays all once every seek has landed (§6.3)', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    // Frame 96 samples 4 s: both lanes are about 3 s off and must seek.
    act(() => hook.result.current.seek(96));
    expect(hook.result.current.state).toBe('waiting');
    expect(a.seeks).toEqual([4]);
    expect(b.seeks).toEqual([4]);
    expect(a.facts.paused).toBe(true);
    expect(b.facts.paused).toBe(true);
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    expect(a.play).toHaveBeenCalledTimes(1);
    tick(2000);
    expect(hook.result.current.frame).toBe(96);
    expect(a.facts.currentTime).toBe(4);
    const pending = deferredPlay();
    b.play.mockReturnValueOnce(pending.promise);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(b.play).toHaveBeenCalledTimes(2);
    // The clock anchors only once every play() has settled.
    expect(hook.result.current.state).toBe('waiting');
    tick(2500);
    expect(hook.result.current.frame).toBe(96);
    await act(async () => {
      b.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.state).toBe('playing');
    tick(2750);
    expect(hook.result.current.frame).toBe(102);
  });

  it('after a user pause brings every lane within half a frame of the paused frame, seeking only those beyond it', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    // 0.03 s ahead: inside the steering tolerance, beyond half a frame.
    at(1000, [[b, 1.03]]);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('paused');
    expect(a.facts.paused).toBe(true);
    expect(b.facts.paused).toBe(true);
    expect(a.seeks).toEqual([]);
    expect(b.seeks).toEqual([1]);
    expect(Math.abs(a.facts.currentTime - 1)).toBeLessThan(HALF_FRAME);
    expect(Math.abs(b.facts.currentTime - 1)).toBeLessThan(HALF_FRAME);
  });

  it('freezes every lane at a stall in a visible playing lane, realigns that lane, and leaves a lane within 0.15 s unsought', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    // The main lane runs 0.1 s ahead of the clock when the upper lane runs dry at frame 30.
    at(1250, [[a, 1.35]]);
    mediaEvent(b, 'waiting', { currentTime: 1.1, readyState: 2 });
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    expect(b.facts.paused).toBe(true);
    expect(b.seeks).toEqual([1.25]);
    expect(a.seeks).toEqual([]);
    tick(5000);
    expect(hook.result.current.frame).toBe(30);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(b.facts.currentTime - 1.25)).toBeLessThan(HALF_FRAME);
    expect(a.seeks).toEqual([]);
    expect(a.play).toHaveBeenCalledTimes(2);
    tick(5250);
    expect(hook.result.current.frame).toBe(36);
  });

  it('counts only visible lanes that should be playing in the buffering check', async () => {
    const later = { ...LANE_B, startFrame: 36, durationFrames: 48 };
    const { hook, a, b } = twoLanes({ readyState: 1 }, {}, later);
    act(() => hook.result.current.toggle());
    await settle();
    // The upper lane is premounted: running dry there holds nothing.
    mediaEvent(b, 'waiting', { readyState: 1 });
    expect(hook.result.current.state).toBe('playing');
    tick(500);
    expect(hook.result.current.frame).toBe(12);
    expect(a.facts.paused).toBe(false);
    expect(b.play).toHaveBeenCalledTimes(0);
  });

  it('only steers a drift that builds up gradually past 0.5 s, never seeking it', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    // The upper lane falls 0.03 s further behind every 50 ms, to 0.9 s.
    for (let step = 1; step <= 30; step += 1) at(step * 50, [[a, step * 0.05], [b, step * 0.05 - step * 0.03]]);
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(36);
    expect(b.seeks).toEqual([]);
    expect(b.facts.playbackRate).toBe(1.03);
    expect(a.seeks).toEqual([]);
  });

  it('hard-syncs a gradual drift once it passes 3 s', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    for (let step = 1; step <= 100; step += 1) at(step * 50, [[a, step * 0.05], [b, step * 0.05 - step * 0.0299]]);
    // 2.99 s behind: still only steered.
    expect(hook.result.current.state).toBe('playing');
    expect(b.seeks).toEqual([]);
    // 3.0199 s behind at 5020 ms, still frame 120.
    at(5020, [[a, 5.02], [b, 5.02 - 3.0199]]);
    expect(hook.result.current.frame).toBe(120);
    expect(hook.result.current.state).toBe('waiting');
    expect(b.seeks).toEqual([5]);
    expect(a.seeks).toEqual([]);
  });

  it('hard-syncs a lane that jumps more than 0.5 s: the preview waits, the lane lands on the frozen frame, and a lane within 0.15 s is left to steering', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1500);
    expect(hook.result.current.frame).toBe(36);
    // The upper lane jumps 0.6 s back; the main lane runs 0.1 s ahead.
    at(1510, [[a, 1.61], [b, 0.91]]);
    expect(hook.result.current.frame).toBe(36);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    expect(b.facts.paused).toBe(true);
    expect(b.seeks).toEqual([1.5]);
    expect(a.seeks).toEqual([]);
    tick(2500);
    expect(hook.result.current.frame).toBe(36);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(b.facts.currentTime - 1.5)).toBeLessThan(HALF_FRAME);
    // Played on from frame 36 at 2500 ms, the main lane is steered back within 0.04 s and returned to its own rate.
    run(6500, 100);
    expect(hook.result.current.state).toBe('playing');
    expect(a.seeks).toEqual([]);
    expect(a.rateWrites).toContain(0.97);
    expect(Math.abs(a.facts.currentTime - 5.5)).toBeLessThanOrEqual(0.04);
    expect(a.facts.playbackRate).toBe(1);
  });

  it('seeks another lane 0.2 s off the frozen frame while waiting, and holds the clock until it lands', async () => {
    const a = mediaFixture();
    const b = mediaFixture();
    const c = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([CLIP, LANE_B, LANE_C], [SOURCE, SOURCE_B, SOURCE_C], THREE_TRACKS),
      media: new Map([[CLIP.id, a], [LANE_B.id, b], [LANE_C.id, c]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1500);
    at(1510, [[b, 0.91], [c, 1.71]]);
    expect(hook.result.current.state).toBe('waiting');
    expect(b.seeks).toEqual([1.5]);
    expect(c.seeks).toEqual([1.5]);
    expect(a.seeks).toEqual([]);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    tick(2500);
    expect(hook.result.current.frame).toBe(36);
    expect(a.play).toHaveBeenCalledTimes(1);
    mediaEvent(c, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect([a.play.mock.calls.length, b.play.mock.calls.length, c.play.mock.calls.length]).toEqual([2, 2, 2]);
    tick(2750);
    expect(hook.result.current.frame).toBe(42);
  });

  it('keeps the clock still after a wait until every lane\'s play() settles', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1500);
    at(1510, [[b, 0.91]]);
    expect(hook.result.current.state).toBe('waiting');
    const pending = deferredPlay();
    a.play.mockReturnValueOnce(pending.promise);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('waiting');
    tick(2500);
    expect(hook.result.current.frame).toBe(36);
    await act(async () => {
      a.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.state).toBe('playing');
    tick(2750);
    expect(hook.result.current.frame).toBe(42);
  });

  it('hard-syncs only the lane a collaborator moved while playing, leaving the lane in place unsought', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    hook.rerender({ ...hook.props, document: timelineDocument([CLIP, { ...LANE_B, startFrame: 12 }], [SOURCE, SOURCE_B], TRACKS) });
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(b.seeks).toEqual([0.5]);
    expect(a.seeks).toEqual([]);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
  });

  it.each([0, 1])('keeps the clock and the playing lane going while a premounted lane has readyState %i', async (readyState) => {
    const later = { ...LANE_B, startFrame: 36, durationFrames: 48 };
    const { hook, a, b } = twoLanes({ readyState }, {}, later);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(1);
    tick(500);
    expect(hook.result.current.frame).toBe(12);
    expect(hook.result.current.state).toBe('playing');
    expect(a.facts.paused).toBe(false);
    expect(b.play).toHaveBeenCalledTimes(0);
  });

  it('seeks a premounted lane to its in-point ahead of its start and keeps it paused', () => {
    const later = { ...LANE_B, startFrame: 36, sourceInFrame: 48, durationFrames: 48 };
    const { hook, b } = twoLanes({}, {}, later);
    expect(hook.result.current.frame).toBe(0);
    expect(b.seeks).toEqual([2]);
    expect(b.facts.paused).toBe(true);
    expect(b.play).toHaveBeenCalledTimes(0);
  });

  it('enters a premounted ready lane at its start frame without stopping the clock or touching the playing lane', async () => {
    const later = { ...LANE_B, startFrame: 24, durationFrames: 48 };
    const { hook, a, b } = twoLanes({}, {}, later);
    act(() => hook.result.current.toggle());
    await settle();
    const pauses = a.pause.mock.calls.length;
    // The boundary at frame 24 is reached at 1000 ms and observed at 1010 ms.
    tick(1010);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(a.pause).toHaveBeenCalledTimes(pauses);
    expect(a.seeks).toEqual([]);
    await settle();
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.state).toBe('playing');
    expect(a.pause).toHaveBeenCalledTimes(pauses);
    expect(a.seeks).toEqual([]);
  });

  it('holds at a boundary until a new lane lands on its target, and does not hard-sync it on the first checks after', async () => {
    const later = { ...LANE_B, startFrame: 24, sourceInFrame: 24, durationFrames: 48 };
    const { hook, a, b } = twoLanes({ readyState: 0 }, {}, later);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    tick(3000);
    expect(hook.result.current.frame).toBe(24);
    mediaEvent(b, 'loadedmetadata', { readyState: 1 });
    expect(b.seeks).toEqual([1]);
    mediaEvent(b, 'canplay', { readyState: 4, seeking: true });
    expect(hook.result.current.state).toBe('waiting');
    expect(b.play).toHaveBeenCalledTimes(0);
    mediaEvent(b, 'seeked', { seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    run(3500);
    expect(hook.result.current.frame).toBe(36);
    expect(hook.result.current.state).toBe('playing');
    expect(b.seeks).toEqual([1]);
    expect(a.seeks).toEqual([]);
  });

  it('crosses several boundaries whose new layers are ready without the untouched lane drifting from the clock', async () => {
    const uppers = [24, 48, 72, 96, 120].map((startFrame, index): TimelineVideoClip => ({
      ...LANE_B, id: `30000000-0000-4000-8000-00000000002${index}`, startFrame, durationFrames: 24,
    }));
    const a = mediaFixture();
    const upperMedia = uppers.map(() => mediaFixture());
    const hook = renderPlayback(a, {
      document: timelineDocument([CLIP, ...uppers], [SOURCE, SOURCE_B], TRACKS),
      media: new Map([[CLIP.id, a], ...uppers.map((clip, index) => [clip.id, upperMedia[index] ?? mediaFixture()] as const)]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    const writes = a.rateWrites.length;
    // The boundaries are reached on the second and observed 10, 20, 30, 40 and 50 ms later: a clock re-anchored at the
    // observation instead of at the boundary would fall a further 10 ms behind the main lane at each one.
    for (const time of [1010, 2020, 3030, 4040, 5050]) {
      tick(time);
      await settle();
    }
    tick(6000);
    expect(hook.result.current.frame).toBe(144);
    expect(hook.result.current.state).toBe('playing');
    expect(a.rateWrites.slice(writes)).toEqual([]);
    expect(a.seeks).toEqual([]);
  });

  it('keeps a lane that ended 20 ms before the clock on its last frame without waiting, seeking or play()', async () => {
    const a = mediaFixture({ duration: 1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, LANE_B], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(960);
    now = 980;
    mediaEvent(a, 'ended', { currentTime: 1, ended: true, paused: true, readyState: 2 });
    const plays = a.play.mock.calls.length;
    const pausesB = b.pause.mock.calls.length;
    for (const time of [1000, 1020, 1040, 1060]) tick(time);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(a.seeks).toEqual([]);
    expect(a.facts.currentTime).toBe(1);
    expect(b.pause).toHaveBeenCalledTimes(pausesB);
    expect(b.facts.paused).toBe(false);
  });

  it('seeks a lagging lane once to the file end when the clock passes it, and holds there while the clock and the other lane go on', async () => {
    const a = mediaFixture({ duration: 1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, LANE_B], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    at(1000, [[a, 0.97]]);
    const plays = a.play.mock.calls.length;
    const pausesB = b.pause.mock.calls.length;
    // The clock samples 1.02 s, past the 1 s file; the element is 10 ms short of its end.
    at(1020, [[a, 0.99]]);
    expect(a.seeks).toHaveLength(1);
    expect(Math.abs((a.seeks[0] ?? 0) - 1)).toBeLessThanOrEqual(0.001);
    expect(a.facts.paused).toBe(true);
    expect(hook.result.current.state).toBe('playing');
    // The seek is still in flight: the clock goes on.
    tick(1040);
    tick(1060);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.state).toBe('playing');
    mediaEvent(a, 'seeked', { seeking: false, ended: true, readyState: 2 });
    tick(1080);
    expect(a.seeks).toHaveLength(1);
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(b.pause).toHaveBeenCalledTimes(pausesB);
  });

  it('keeps playing while the one tail seek is in flight even when the element drops to readyState 1 during it (§6.3)', async () => {
    const a = mediaFixture({ duration: 1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, LANE_B], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    // The element lags 30 ms behind the clock, so it has not ended yet.
    tick(1000, () => Object.assign(a.facts, { currentTime: 0.97, ended: false, paused: false }));
    const plays = a.play.mock.calls.length;
    const pausesB = b.pause.mock.calls.length;
    // The clock samples 1.02 s, past the 1 s file; the element is 10 ms short of its end and seeks there once.
    at(1020, [[a, 0.99]]);
    expect(a.seeks).toHaveLength(1);
    expect(Math.abs((a.seeks[0] ?? 0) - 1)).toBeLessThanOrEqual(0.001);
    expect(a.facts.ended).toBe(false);
    // Real browsers lower readyState while a seek is in flight, and announce it with `seeking`.
    mediaEvent(a, 'seeking', { seeking: true, readyState: 1 });
    expect(hook.result.current.state).toBe('playing');
    expect(b.facts.paused).toBe(false);
    tick(1040);
    tick(1060);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.state).toBe('playing');
    mediaEvent(a, 'seeked', { seeking: false, ended: true, readyState: 2 });
    tick(1080);
    expect(hook.result.current.state).toBe('playing');
    expect(a.seeks).toHaveLength(1);
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(b.pause).toHaveBeenCalledTimes(pausesB);
    expect(b.facts.paused).toBe(false);
  });

  it('resumes after a stall in one lane while another holds its tail, without play() on the held lane', async () => {
    const a = mediaFixture({ duration: 1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, LANE_B], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(960);
    now = 980;
    mediaEvent(a, 'ended', { currentTime: 1, ended: true, paused: true, readyState: 2 });
    const plays = a.play.mock.calls.length;
    tick(1000);
    mediaEvent(b, 'waiting', { currentTime: 0.98, readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    expect(b.seeks).toEqual([1]);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(a.seeks).toEqual([]);
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
  });

  it('holds a lane that ended 20 ms ahead of a clock still inside its file on its last picture, without seek, play() or waiting', async () => {
    const a = mediaFixture({ duration: 1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, LANE_B], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(960);
    const plays = a.play.mock.calls.length;
    const pausesB = b.pause.mock.calls.length;
    // The clock samples 0.98 s, inside the 1 s file; the element already played to its end, 0.02 s ahead of it.
    tick(980, () => Object.assign(a.facts, { currentTime: 1, ended: true, paused: true, readyState: 2 }));
    mediaEvent(a, 'ended');
    tick(990);
    expect(hook.result.current.state).toBe('playing');
    expect(a.seeks).toEqual([]);
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(a.facts.currentTime).toBe(1);
    expect(b.pause).toHaveBeenCalledTimes(pausesB);
    expect(b.facts.paused).toBe(false);
    tick(1060);
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.state).toBe('playing');
    expect(a.seeks).toEqual([]);
    expect(a.play).toHaveBeenCalledTimes(plays);
  });

  // A's 1.030 s file under TAIL_CLIP; B starts at frame 25 (1.0417 s), the first frame whose source time is past A's end.
  it.each([
    ['an animation frame lands between the file end and the boundary', [1000, 1035, 1045]],
    ['no animation frame lands between the file end and the boundary', [1000, 1025, 1045]],
  ] as const)('crosses into a lane\'s tail at a boundary frame without waiting when %s: one seek to the file end, the new lane starts (§6.3)', async (_name, times) => {
    const a = mediaFixture({ duration: 1.03 });
    const b = mediaFixture();
    const upper: TimelineVideoClip = { ...LANE_B, startFrame: 25, durationFrames: 48 };
    const hook = renderPlayback(a, {
      document: timelineDocument([TAIL_CLIP, upper], [TAIL_SOURCE, SOURCE_B], TRACKS),
      media: new Map([[TAIL_CLIP.id, a], [upper.id, b]]),
    });
    await settle();
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    const plays = a.play.mock.calls.length;
    for (const time of times) {
      // A lags the clock by 20 ms, inside the 0.04 s steering band, and has not reached its end.
      tick(time, () => {
        if (!a.facts.ended) a.facts.currentTime = Math.min(1.03, (time - 20) / 1000);
      });
      await settle();
    }
    expect(hook.result.current.frame).toBe(25);
    expect(hook.result.current.state).toBe('playing');
    expect(b.facts.paused).toBe(false);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(a.seeks).toHaveLength(1);
    expect(Math.abs((a.seeks[0] ?? 0) - 1.03)).toBeLessThanOrEqual(0.001);
    expect(a.facts.paused).toBe(true);
    mediaEvent(a, 'seeked', { seeking: false, currentTime: 1.03, ended: true, readyState: 2 });
    await settle();
    // Off a frame edge, so float rounding at the boundary anchor cannot decide the frame.
    tick(1260);
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.state).toBe('playing');
    expect(b.facts.paused).toBe(false);
    expect(a.seeks).toHaveLength(1);
    expect(a.play).toHaveBeenCalledTimes(plays);
  });

  it('makes the whole preview wait for a lane retried while playing, and goes on with every lane once it is ready', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    mediaEvent(b, 'error', { error: { code: 2, message: 'Network failed' } as MediaError });
    expect(hook.result.current.state).toBe('playing');
    tick(1500);
    expect(hook.result.current.frame).toBe(36);
    act(() => hook.result.current.retryVideo(LANE_B.id));
    expect(b.load).toHaveBeenCalledTimes(1);
    expect(a.load).toHaveBeenCalledTimes(0);
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    tick(3000);
    expect(hook.result.current.frame).toBe(36);
    mediaEvent(b, 'loadedmetadata', { readyState: 1, duration: 10 });
    expect(b.facts.currentTime).toBe(1.5);
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    expect(a.facts.paused).toBe(false);
    expect(b.facts.paused).toBe(false);
    tick(3250);
    expect(hook.result.current.frame).toBe(42);
    // Landed on its target, the retried lane is not hard-synced by the checks that follow.
    run(3500);
    expect(hook.result.current.state).toBe('playing');
    expect(b.seeks).toEqual([1.5]);
    expect(a.seeks).toEqual([]);
  });

  it('releases the wait when a lane retried while playing fails again: the other lanes go on and the layer is unavailable again', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    mediaEvent(b, 'error', { error: { code: 2, message: 'Network failed' } as MediaError });
    act(() => hook.result.current.retryVideo(LANE_B.id));
    expect(hook.result.current.state).toBe('waiting');
    expect(hook.result.current.videoStates.get(LANE_B.id)).not.toBe('failed');
    tick(2000);
    mediaEvent(b, 'error', { error: { code: 2, message: 'Network failed' } as MediaError });
    await settle();
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('failed');
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('playing');
    expect(a.facts.paused).toBe(false);
    tick(2250);
    expect(hook.result.current.frame).toBe(30);
  });

  it.each(['asset', 'element'] as const)('reloads only the failed lane on its retry after its %s failed', async (failure) => {
    const { hook, a, b } = twoLanes(failure === 'element' ? { readyState: 0, error: { code: 4, message: 'Media unavailable' } as MediaError } : {},
      failure === 'asset' ? { assets: { [LANE_B.id]: 'failed' } } : {});
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('failed');
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    act(() => hook.result.current.retryVideo(LANE_B.id));
    expect(a.load).toHaveBeenCalledTimes(0);
    expect(a.seeks).toEqual([]);
    if (failure === 'element') expect(b.load).toHaveBeenCalledTimes(1);
  });

  it('counts a visible lane whose asset is loading as not ready and reports it loading', async () => {
    const { hook, a, b } = twoLanes({}, { assets: { [LANE_B.id]: 'loading' } });
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('loading');
    expect(hook.result.current.videoStates.get(CLIP.id)).toBe('ready');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    expect(a.play).toHaveBeenCalledTimes(0);
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
    hook.rerender({ ...hook.props, assets: {} });
    await settle();
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(b.play).toHaveBeenCalledTimes(1);
  });

  it('does not count networkState 3 with no error right after src as a failure, and starts the lane once it has data', async () => {
    const { hook, b } = twoLanes({ readyState: 0, networkState: 3 });
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('ready');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    expect(b.play).toHaveBeenCalledTimes(0);
    mediaEvent(b, 'loadeddata', { networkState: 1, readyState: 4 });
    await settle();
    expect(hook.result.current.videoStates.get(LANE_B.id)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    expect(b.play).toHaveBeenCalledTimes(1);
  });

  it('treats an AbortError from a new lane\'s pending play() as no failure when another lane stalls at the boundary, and goes on with both', async () => {
    const later = { ...LANE_B, startFrame: 24, durationFrames: 48 };
    const { hook, a, b } = twoLanes({}, {}, later);
    const pending = deferredPlay();
    b.play.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('playing');
    expect(b.play).toHaveBeenCalledTimes(1);
    mediaEvent(a, 'waiting', { readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    // Pausing the new lane interrupts its play().
    await act(async () => {
      pending.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
      await Promise.resolve();
    });
    expect(hook.result.current.videoStates.get(later.id)).toBe('ready');
    expect(hook.result.current.intent).toBe('play');
    expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(0);
    mediaEvent(a, 'canplay', { readyState: 4 });
    await settle();
    expect(b.play).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.frame).toBe(30);
  });

  it('pauses a lane that already started when a retried lane\'s asset turns loading before every play() settled, and resumes every lane from the held frame', async () => {
    const { hook, a, b } = twoLanes({}, { assets: { [LANE_B.id]: 'failed' } });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    // The retry holds the preview and the main lane is asked to play again; the retried asset reads as loading
    // before that play() settles.
    act(() => hook.result.current.retryVideo(LANE_B.id));
    hook.rerender({ ...hook.props, assets: { [LANE_B.id]: 'loading' } });
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    const held = a.facts.currentTime;
    tick(3000);
    expect(hook.result.current.frame).toBe(24);
    expect(a.facts.currentTime).toBe(held);
    hook.rerender({ ...hook.props, assets: {} });
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(a.facts.currentTime - 1)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 1)).toBeLessThan(ONE_FRAME);
    tick(3250);
    expect(hook.result.current.frame).toBe(30);
    expect(Math.abs(a.facts.currentTime - 30 / 24)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 30 / 24)).toBeLessThan(ONE_FRAME);
  });

  it('seeks a lane that ran past the resume threshold while another lane\'s play() was pending back to the held frame, and anchors the clock only once it lands', async () => {
    const { hook, a, b } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const pending = deferredPlay();
    b.play.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.seek(120));
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    // The main lane's play() has settled; the upper lane's is still pending.
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(b.play).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toBe('waiting');
    expect(a.seeks).toEqual([5]);
    // The main lane plays 0.3 s past the held frame, beyond the 0.15 s resume threshold, before the upper lane stalls.
    tick(1300);
    expect(hook.result.current.frame).toBe(120);
    mediaEvent(b, 'waiting', { readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    expect(a.facts.paused).toBe(true);
    const playsAtStall = a.play.mock.calls.length;
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    mediaEvent(b, 'canplay', { readyState: 4 });
    await settle();
    // The main lane is sought back to 5 s and the preview waits for it to land, without starting it.
    expect(a.seeks).toEqual([5, 5]);
    expect(hook.result.current.state).toBe('waiting');
    expect(a.play).toHaveBeenCalledTimes(playsAtStall);
    tick(2000);
    expect(hook.result.current.frame).toBe(120);
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(a.facts.currentTime - 5)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 5)).toBeLessThan(ONE_FRAME);
    tick(2250);
    expect(hook.result.current.frame).toBe(126);
    expect(Math.abs(a.facts.currentTime - 126 / 24)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 126 / 24)).toBeLessThan(ONE_FRAME);
  });

  it('seeks a lane that ran to its file end during a wait back to the held frame inside its file, and plays every lane on once it lands (§6.3)', async () => {
    // A's file ends at 5.2 s; frame 120 samples 5.0 s, 0.2 s before that end and beyond the 0.15 s resume threshold.
    const a = mediaFixture({ duration: 5.2 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([CLIP, LANE_B], [SOURCE, SOURCE_B], TRACKS),
      media: new Map([[CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const pending = deferredPlay();
    b.play.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.seek(120));
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    expect(a.seeks).toEqual([5]);
    // A plays 0.5 s while B's play() is pending and reaches its 5.2 s end; then B stalls.
    tick(1500);
    expect(hook.result.current.frame).toBe(120);
    expect(a.facts.ended).toBe(true);
    mediaEvent(a, 'ended');
    mediaEvent(b, 'waiting', { readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    mediaEvent(b, 'canplay', { readyState: 4 });
    await settle();
    // The held frame's source time is inside A's file: A is sought back to 5 s and the preview waits for it to land.
    expect(a.seeks).toEqual([5, 5]);
    expect(hook.result.current.state).toBe('waiting');
    tick(2000);
    expect(hook.result.current.frame).toBe(120);
    mediaEvent(a, 'seeked', { seeking: false, ended: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(Math.abs(a.facts.currentTime - 5)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 5)).toBeLessThan(ONE_FRAME);
    tick(2100);
    expect(hook.result.current.frame).toBe(122);
    expect(Math.abs(a.facts.currentTime - 122 / 24)).toBeLessThan(ONE_FRAME);
    expect(Math.abs(b.facts.currentTime - 122 / 24)).toBeLessThan(ONE_FRAME);
  });

  it('leaves a lane at its file end 0.1 s ahead of the held frame unsought through a wait, never calls play() on it, and resumes the preview (§6.3)', async () => {
    // A's file ends at 5.1 s; frame 120 samples 5.0 s: 0.1 s ahead, beyond the 0.04 s lead and within the 0.15 s threshold.
    const a = mediaFixture({ duration: 5.1 });
    const b = mediaFixture();
    const hook = renderPlayback(a, {
      document: timelineDocument([CLIP, LANE_B], [SOURCE, SOURCE_B], TRACKS),
      media: new Map([[CLIP.id, a], [LANE_B.id, b]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    const pending = deferredPlay();
    b.play.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.seek(120));
    mediaEvent(a, 'seeked', { seeking: false, readyState: 4 });
    mediaEvent(b, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    // A reaches its end while the clock is held, then B stalls.
    mediaEvent(a, 'ended', { currentTime: 5.1, ended: true, paused: true, readyState: 2 });
    const plays = a.play.mock.calls.length;
    mediaEvent(b, 'waiting', { readyState: 2 });
    expect(hook.result.current.state).toBe('waiting');
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    mediaEvent(b, 'canplay', { readyState: 4 });
    await settle();
    expect(a.seeks).toEqual([5]);
    expect(a.play).toHaveBeenCalledTimes(plays);
    expect(hook.result.current.state).toBe('playing');
    tick(1250);
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(126);
    expect(a.play).toHaveBeenCalledTimes(plays);
  });
});

describe('video lane rate steering (#1410 design §6.3, §6.4)', () => {
  it('steers a lane 3% only past 0.04 s and restores its rate within 0.01 s or when the drift turns', async () => {
    const { hook, a } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    const writes = a.rateWrites.length;
    // 0.03 s behind: left alone.
    at(1000, [[a, 0.97]]);
    expect(a.rateWrites.slice(writes)).toEqual([]);
    // 0.05 s behind: 3% faster.
    at(1100, [[a, 1.05]]);
    expect(a.rateWrites.slice(writes)).toEqual([1.03]);
    // 0.005 s behind: back to its own rate.
    at(1200, [[a, 1.195]]);
    expect(a.rateWrites.slice(writes)).toEqual([1.03, 1]);
    // 0.05 s ahead: 3% slower.
    at(1300, [[a, 1.35]]);
    expect(a.rateWrites.slice(writes)).toEqual([1.03, 1, 0.97]);
    // 0.02 s behind: the drift turned, back to its own rate.
    at(1400, [[a, 1.38]]);
    expect(a.rateWrites.slice(writes)).toEqual([1.03, 1, 0.97, 1]);
    expect(a.seeks).toEqual([]);
    expect(hook.result.current.state).toBe('playing');
  });

  it('measures drift on the continuous clock: at 24 fps an element in step with it is never re-rated', async () => {
    const { hook, a } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    const writes = a.rateWrites.length;
    // 1041 ms shows frame 24 (1.000 s); the element in step with the clock is 41 ms past that frame.
    for (const time of [1041, 2082, 3123, 4040]) at(time, [[a, time / 1000]]);
    expect(hook.result.current.frame).toBe(96);
    expect(a.rateWrites.slice(writes)).toEqual([]);
    expect(a.seeks).toEqual([]);
  });

  it.each([[5e-7, []], [2e-6, [1]]] as const)('rewrites a lane rate %d off its target only when it is more than 1e-6 off', async (off, expected) => {
    const { hook, a } = twoLanes();
    act(() => hook.result.current.toggle());
    await settle();
    tick(500);
    const writes = a.rateWrites.length;
    a.facts.playbackRate = 1 + off;
    tick(1000);
    tick(1500);
    expect(a.rateWrites.slice(writes)).toEqual(expected);
  });

  it('calls play() once while it is pending, whatever checks run meanwhile', async () => {
    const { hook, a, b } = twoLanes();
    const pending = deferredPlay();
    a.play.mockReturnValueOnce(pending.promise);
    act(() => hook.result.current.toggle());
    for (const event of ['canplay', 'canplaythrough', 'loadeddata', 'timeupdate', 'progress']) mediaEvent(a, event, { readyState: 4 });
    mediaEvent(b, 'timeupdate');
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state).toBe('waiting');
    await act(async () => {
      a.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(hook.result.current.state).toBe('playing');
  });
});
