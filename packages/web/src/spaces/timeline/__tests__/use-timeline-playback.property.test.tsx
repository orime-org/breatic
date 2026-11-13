// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Property-based check of the Timeline preview over two video lanes (#1410 design §6.3, §7.3). Each run builds a
 * document with two video clips on two tracks (random start, length, in-point and file duration, the file sometimes
 * shorter than the clip so a tail happens, sometimes not a whole number of frames, sometimes the second clip starting
 * exactly where the first one's tail begins; each element's decoder clock a little off), then has the user press play,
 * often after seeking to a few frames before the first lane's tail, and plays 4 to 24 random commands: play/pause, a
 * user seek, time passing, a lane stalling, recovering, its metadata arriving or a pending seek landing, a late play()
 * settling, a timeupdate, a lane's decoder jumping 0.6 to 2.5 s (on the next tick on which a visible lane plays).
 * Three fixed runs, a lane more than `resume_seek_seconds` ahead in the resume step, always run first. After each
 * command:
 *
 * - while waiting, the clock does not move and no visible lane plays, except in the resume step (every visible lane in
 *   place and a play() of the resume still pending);
 * - a lane in its tail never turns 'playing' into 'waiting' by itself, gets at most one seek (to its file end) while
 *   playing and stays paused;
 * - when the preview starts playing, every visible lane not in its tail is within `resume_seek_seconds` of the clock's
 *   source time, plus what it played on in the resume step after the last hold (the design starts every lane and
 *   anchors the clock once every play() has settled, so a lane that started first runs ahead by the others' delay);
 * - within two ticks of a playing lane not in its tail jumping more than `drift_hard_sync_seconds`, the preview waits
 *   and seeks that lane to the held frame's source time, or the lane is back within that threshold.
 *
 * At the end every element is made healthy and time passes: a preview the user wants playing is not left waiting.
 *
 * The fake element follows the browser: it starts with readyState 0 and no duration, and ignores currentTime writes,
 * until its metadata arrives (`loadedmetadata`); a seek sets `seeking` and HAVE_METADATA until `seeked`, clamped to the
 * duration; play() unpauses at once and its promise settles once the element has data (or later, when the run asks),
 * and the element advances only once it has settled;
 * pause() rejects pending play() with AbortError; play() of an ended element seeks to 0; an element reaching its end
 * pauses, reports HAVE_CURRENT_DATA and fires `ended`.
 */

import * as React from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIMELINE_PREVIEW_DEFAULTS, type TimelineDocumentV1, type TimelineTrack, type TimelineVideoClip, type TimelineVideoSource } from '@breatic/shared';
import { resolveTimelineArrangement } from '@web/data/yjs/timeline-arrangement';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';

vi.mock('@web/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

type PlaybackResult = ReturnType<typeof useTimelinePlayback> & { frame: number };
type Transport = PlaybackResult['state'];

const FPS = 24;
// `web_animation.preview_premount_ms` (2000, design §6.4) at 24 fps.
const PREMOUNT_FRAMES = 48;
const END_TOLERANCE = 0.001;
const EPSILON = 1e-6;
// Room for the drift the playback measures on its continuous clock against the frame the checks read, over one tick.
const JUMP_MARGIN = 0.1;
const { resumeSeekSeconds: RESUME_SECONDS, driftHardSyncSeconds: HARD_SYNC_SECONDS } = TIMELINE_PREVIEW_DEFAULTS;
const TRACKS: TimelineTrack[] = [{ id: 'visual-1', kind: 'visual', order: 0 }, { id: 'v2', kind: 'visual', order: 1 }];
const CLIP_IDS = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'] as const;

/**
 * One generated lane: its placement, its file's real duration, how far its element has loaded when created, and how
 * far its decoder's clock runs off the wall clock (a real element drifts; the playback steers it back).
 */
interface LaneSpec {
  start: number;
  durationFrames: number;
  inFrame: number;
  fileSeconds: number;
  initialReadyState: 1 | 4;
  skew: number;
}

interface Facts {
  paused: boolean;
  currentTime: number;
  duration: number;
  seeking: boolean;
  readyState: number;
  playbackRate: number;
}

interface PendingPlay {
  late: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Fake {
  clipId: string;
  spec: LaneSpec;
  skew: number;
  element: HTMLVideoElement;
  facts: Facts;
  pending: PendingPlay[];
  /** Every currentTime the element was given. */
  seeks: number[];
  /** Seconds it played while the transport was waiting, since its own last seek or any lane's last pause(). */
  ahead: number;
}

type LaneIndex = 0 | 1;
type Command =
  | { op: 'toggle' }
  | { op: 'seek'; at: number }
  | { op: 'advance'; ms: number }
  | { op: 'stall'; lane: LaneIndex }
  | { op: 'recover'; lane: LaneIndex }
  | { op: 'land'; lane: LaneIndex }
  | { op: 'resolve'; lane: LaneIndex }
  | { op: 'timeupdate'; lane: LaneIndex }
  | { op: 'jump'; lane: LaneIndex; by: number };

interface Snapshot { state: Transport; intent: 'play' | 'pause'; frame: number }

/** What one run sets up and the fakes read. */
interface RunContext {
  now: number;
  nextFrameId: number;
  queued: Map<number, FrameRequestCallback>;
  fakes: Fake[];
  byElement: WeakMap<HTMLVideoElement, Fake>;
  lateFlags: readonly boolean[];
  plays: number;
  immediate: boolean;
  transport: () => Transport;
}

/** Runs in which each situation happened at least once, to show the property is not vacuous. */
const reached = { runs: 0, playing: 0, waiting: 0, tailWhilePlaying: 0, userSeekWhilePlaying: 0, tailSeekWhilePlaying: 0, resumeAfterWait: 0, lateResolve: 0, aheadAtResume: 0, jumpWhilePlaying: 0 };

let ctx: RunContext = newContext([false]);

/**
 * A fresh run context.
 * @param lateFlags - Per play() call in turn, whether its promise waits for a `resolve` command.
 * @returns The context.
 * @throws {never} Never.
 */
function newContext(lateFlags: readonly boolean[]): RunContext {
  return {
    now: 0, nextFrameId: 0, queued: new Map(), fakes: [], byElement: new WeakMap(), lateFlags, plays: 0, immediate: false,
    transport: () => 'paused',
  };
}

beforeEach(() => {
  vi.spyOn(performance, 'now').mockImplementation(() => ctx.now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    ctx.nextFrameId += 1;
    ctx.queued.set(ctx.nextFrameId, callback);
    return ctx.nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    ctx.queued.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Whether an element sits within 1 ms of its file end.
 * @param fake - The element.
 * @returns Whether it is at its end.
 * @throws {never} Never.
 */
function atEnd(fake: Fake): boolean {
  return Math.abs(fake.facts.currentTime - fake.facts.duration) <= END_TOLERANCE;
}

/**
 * Whether an element has played to its end.
 * @param fake - The element.
 * @returns Whether it ended.
 * @throws {never} Never.
 */
function ended(fake: Fake): boolean {
  return !fake.facts.seeking && fake.facts.currentTime >= fake.facts.duration;
}

/**
 * Whether an element can play on: not seeking and HAVE_FUTURE_DATA.
 * @param fake - The element.
 * @returns Whether it has data.
 * @throws {never} Never.
 */
function hasData(fake: Fake): boolean {
  return !fake.facts.seeking && fake.facts.readyState >= 3;
}

/**
 * The readyState a healthy element reports where it is: HAVE_CURRENT_DATA at its end, HAVE_ENOUGH_DATA elsewhere.
 * @param fake - The element.
 * @returns The readyState.
 * @throws {never} Never.
 */
function healthyLevel(fake: Fake): number {
  return fake.facts.currentTime >= fake.facts.duration ? 2 : 4;
}

/**
 * Reject every pending play() with AbortError, as pause() and reaching the end do.
 * @param fake - The element.
 * @throws {never} Never.
 */
function abortPlays(fake: Fake): void {
  const pending = fake.pending.splice(0);
  for (const play of pending) play.reject(new DOMException('The play() request was interrupted.', 'AbortError'));
}

/**
 * Resolve the pending play() calls the element can honour now.
 * @param fake - The element.
 * @param includeLate - Whether late ones settle too.
 * @throws {never} Never.
 */
function honourPlays(fake: Fake, includeLate: boolean): void {
  if (!hasData(fake) || fake.facts.paused) return;
  const keep: PendingPlay[] = [];
  for (const play of fake.pending) {
    if (play.late && !includeLate) keep.push(play);
    else play.resolve();
  }
  fake.pending = keep;
}

/**
 * Start a seek of the element, clamped to its duration.
 * @param fake - The element.
 * @param value - The requested time.
 * @throws {never} Never.
 */
function startSeek(fake: Fake, value: number): void {
  const target = Math.max(0, Math.min(fake.facts.duration, value));
  fake.ahead = 0;
  if (target === fake.facts.currentTime && !fake.facts.seeking) return;
  fake.facts.currentTime = target;
  fake.facts.seeking = true;
  fake.facts.readyState = Math.min(fake.facts.readyState, 1);
}

/**
 * Play the element to its end: it pauses, holds the last picture and rejects pending play().
 * @param fake - The element.
 * @throws {never} Never.
 */
function reachEnd(fake: Fake): void {
  fake.facts.currentTime = fake.facts.duration;
  fake.facts.readyState = 2;
  if (!fake.facts.paused) {
    fake.facts.paused = true;
    abortPlays(fake);
  }
}

/**
 * Create a fake element for one lane.
 * @param clipId - The lane's clip.
 * @param spec - The lane.
 * @returns The fake.
 * @throws {Error} When a property cannot be installed.
 */
function createFake(clipId: string, spec: LaneSpec): Fake {
  const element = document.createElement('video');
  // As in a browser, a new element knows nothing of its file until its metadata arrives (the first `land`).
  const facts: Facts = { paused: true, currentTime: 0, duration: Number.NaN, seeking: false, readyState: 0, playbackRate: 1 };
  const fake: Fake = { clipId, spec, skew: spec.skew, element, facts, pending: [], seeks: [], ahead: 0 };
  for (const key of ['paused', 'duration', 'seeking', 'readyState'] as const) {
    Object.defineProperty(element, key, { configurable: true, get: () => facts[key] });
  }
  Object.defineProperty(element, 'ended', { configurable: true, get: () => ended(fake) });
  Object.defineProperty(element, 'error', { configurable: true, get: () => null });
  Object.defineProperty(element, 'networkState', { configurable: true, get: () => 1 });
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => facts.currentTime,
    set: (value: number) => {
      fake.seeks.push(value);
      if (facts.readyState === 0) return;
      startSeek(fake, value);
    },
  });
  Object.defineProperty(element, 'playbackRate', {
    configurable: true,
    get: () => facts.playbackRate,
    set: (value: number) => {
      facts.playbackRate = value;
    },
  });
  Object.defineProperty(element, 'play', {
    configurable: true,
    value: (): Promise<void> => {
      // HTML: play() of an ended element seeks to the start first.
      if (ended(fake)) startSeek(fake, 0);
      facts.paused = false;
      const late = !ctx.immediate && (ctx.lateFlags[ctx.plays % ctx.lateFlags.length] ?? false);
      ctx.plays += 1;
      const promise = new Promise<void>((resolve, reject) => {
        fake.pending.push({ late, resolve, reject });
      });
      honourPlays(fake, false);
      return promise;
    },
  });
  Object.defineProperty(element, 'pause', {
    configurable: true,
    value: (): void => {
      // A pause is a hold (or the user's pause): from here on every lane is to be back within the threshold.
      for (const other of ctx.fakes) other.ahead = 0;
      if (facts.paused) return;
      facts.paused = true;
      abortPlays(fake);
    },
  });
  Object.defineProperty(element, 'load', { configurable: true, value: (): void => undefined });
  ctx.fakes.push(fake);
  ctx.byElement.set(element, fake);
  return fake;
}

/**
 * The document of a run.
 * @param lanes - The two lanes.
 * @returns The Timeline.
 * @throws {never} Never.
 */
function timelineDocument(lanes: readonly LaneSpec[]): TimelineDocumentV1 {
  const sources: TimelineVideoSource[] = lanes.map((_, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index + 1}`,
    kind: 'video',
    assetId: `20000000-0000-4000-8000-00000000000${index + 1}`,
    timebase: { num: FPS, den: 1 },
    // The registered duration covers every clip; the element's own duration decides the tail (#1410 design §6.3).
    extentFrames: 2400,
    durationSeconds: '100',
    durationOrigin: 'registered',
  }));
  const clips: TimelineVideoClip[] = lanes.map((lane, index) => ({
    id: CLIP_IDS[index] ?? '', trackId: TRACKS[index]?.id ?? '', kind: 'video', sourceId: sources[index]?.id ?? '',
    startFrame: lane.start, sourceInFrame: lane.inFrame, durationFrames: lane.durationFrames, rate: { num: 1, den: 1 },
    gain: 1, mute: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  }));
  return {
    schemaVersion: 1,
    settings: { width: 1920, height: 1080, fps: { num: FPS, den: 1 } },
    tracks: Object.fromEntries(TRACKS.map((track) => [track.id, track])),
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    sources: Object.fromEntries(sources.map((source) => [source.id, source])),
    operationReceipts: {},
  };
}

/**
 * Render the hook as the Space would: the visible and premounted video clips bottom-up, one fake element per creation.
 * @param document - The Timeline.
 * @param lanes - The lanes, by clip order.
 * @returns The hook.
 * @throws {Error} When rendering fails.
 */
function renderPlayback(document: TimelineDocumentV1, lanes: readonly LaneSpec[]): RenderHookResult<PlaybackResult, undefined> {
  return renderHook((): PlaybackResult => {
    const [frame, setFrame] = React.useState(0);
    const onFrame = React.useCallback((value: number): void => setFrame(value), []);
    const createMedia = React.useCallback((clipId: string): HTMLVideoElement => {
      const index = CLIP_IDS.indexOf(clipId as (typeof CLIP_IDS)[number]);
      const spec = lanes[index];
      if (spec === undefined) throw new Error(`unknown clip ${clipId}`);
      return createFake(clipId, spec).element;
    }, []);
    const ready = React.useMemo(() => new Set(resolveTimelineArrangement(document).readyClipIds), []);
    const layersNow = Object.values(document.clips)
      .filter((clip) => ready.has(clip.id) && frame < clip.startFrame + clip.durationFrames && frame >= clip.startFrame - PREMOUNT_FRAMES)
      .sort((a, b) => (a.trackId === 'visual-1' ? 0 : 1) - (b.trackId === 'visual-1' ? 0 : 1))
      .map((clip) => ({ clipId: clip.id, fileUrl: `https://cdn.test/${clip.id}.mp4`, coverUrl: null, state: 'ready' as const }));
    const signature = JSON.stringify(layersNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer set changes only when its content does.
    const videoLayers = React.useMemo(() => layersNow, [signature]);
    return {
      ...useTimelinePlayback({ document, readyClipIds: ready, frame, onFrame, videoLayers, createMedia, enabled: true }),
      frame,
    };
  });
}

/**
 * Let promise settlement and the hook's reactions run.
 * @throws {Error} When an update fails.
 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await Promise.resolve();
  });
}

/**
 * Pass time: playing elements advance at their rate, then the frame callbacks requested before run, then `ended`. An
 * element whose play() has not settled has not started: a browser settles it when playback begins.
 * @param ms - The elapsed milliseconds.
 * @throws {Error} When a callback fails.
 */
function advance(ms: number): void {
  const waiting = ctx.transport() === 'waiting';
  const finished: Fake[] = [];
  for (const fake of ctx.fakes) {
    const { facts } = fake;
    if (facts.paused || facts.seeking || facts.readyState < 3 || fake.pending.length > 0) continue;
    const next = facts.currentTime + ms / 1000 * facts.playbackRate * (1 + fake.skew);
    if (waiting) fake.ahead += Math.min(next, facts.duration) - facts.currentTime;
    if (next >= facts.duration) {
      reachEnd(fake);
      finished.push(fake);
    } else {
      facts.currentTime = next;
    }
  }
  ctx.now += ms;
  const due = [...ctx.queued.values()];
  ctx.queued.clear();
  act(() => {
    for (const callback of due) callback(ctx.now);
    for (const fake of finished) fake.element.dispatchEvent(new Event('ended'));
  });
}

/**
 * Deliver an element's metadata if it has none yet (its duration and first readyState, `loadedmetadata`); otherwise
 * land its pending seek: data at the new position, `seeked`, and `ended` when it landed at the end.
 * @param fake - The element.
 * @throws {Error} When a handler fails.
 */
function land(fake: Fake): void {
  if (fake.facts.readyState === 0) {
    act(() => {
      fake.facts.duration = fake.spec.fileSeconds;
      fake.facts.readyState = fake.spec.initialReadyState;
      fake.element.dispatchEvent(new Event('loadedmetadata'));
    });
    return;
  }
  if (!fake.facts.seeking) return;
  act(() => {
    fake.facts.seeking = false;
    fake.facts.readyState = healthyLevel(fake);
    const atFileEnd = fake.facts.currentTime >= fake.facts.duration;
    if (atFileEnd) reachEnd(fake);
    honourPlays(fake, false);
    fake.element.dispatchEvent(new Event('seeked'));
    if (atFileEnd) fake.element.dispatchEvent(new Event('ended'));
  });
}

/**
 * Give a stalled element its data back.
 * @param fake - The element.
 * @throws {Error} When a handler fails.
 */
function recover(fake: Fake): void {
  if (fake.facts.seeking || fake.facts.readyState === 0) return;
  act(() => {
    fake.facts.readyState = healthyLevel(fake);
    honourPlays(fake, false);
    fake.element.dispatchEvent(new Event('canplay'));
  });
}

/**
 * Settle the oldest late play(): now if the element has data, else as soon as it does.
 * @param fake - The element.
 * @returns Whether a late play() existed.
 * @throws {Error} When a handler fails.
 */
function resolveLate(fake: Fake): boolean {
  const play = fake.pending.find((item) => item.late);
  if (play === undefined) return false;
  play.late = false;
  act(() => honourPlays(fake, false));
  return true;
}

/**
 * Make a playing element's decoder skip, as a real one may: its time jumps, clamped to its file.
 * @param fake - The element.
 * @param by - The seconds it jumps.
 * @returns Whether it jumped.
 * @throws {never} Never.
 */
function jump(fake: Fake, by: number): boolean {
  const { facts } = fake;
  if (facts.paused || facts.seeking || facts.readyState < 3 || fake.pending.length > 0) return false;
  facts.currentTime = Math.max(0, Math.min(facts.duration, facts.currentTime + by));
  return true;
}

/**
 * The source time a lane's clip shows at a frame.
 * @param spec - The lane.
 * @param frame - The frame.
 * @returns The source seconds.
 * @throws {never} Never.
 */
function targetAt(spec: LaneSpec, frame: number): number {
  return (spec.inFrame + frame - spec.start) / FPS;
}

/** One lane as the checks see it after a command. */
interface LaneView {
  index: LaneIndex;
  spec: LaneSpec;
  fake: Fake;
  target: number;
  /** The clip's source time at the frame is past the file, or the element sits at its end. */
  tail: boolean;
}

/**
 * The visible lanes: their clip covers the frame and the controller holds an element for it.
 * @param hook - The hook.
 * @param lanes - The lanes.
 * @returns The lanes.
 * @throws {never} Never.
 */
function visibleLanes(hook: RenderHookResult<PlaybackResult, undefined>, lanes: readonly LaneSpec[]): LaneView[] {
  const { frame } = hook.result.current;
  const views: LaneView[] = [];
  lanes.forEach((spec, position) => {
    const index = position as LaneIndex;
    const element = hook.result.current.videoElement(CLIP_IDS[index]);
    const fake = element === undefined ? undefined : ctx.byElement.get(element);
    if (fake === undefined || frame < spec.start || frame >= spec.start + spec.durationFrames) return;
    const target = targetAt(spec, frame);
    views.push({ index, spec, fake, target, tail: target > fake.facts.duration + EPSILON || atEnd(fake) });
  });
  return views;
}

/**
 * Describe the lanes for a failure message.
 * @param views - The lanes.
 * @returns The description.
 * @throws {never} Never.
 */
function describeLanes(views: readonly LaneView[]): string {
  return JSON.stringify(views.map(({ index, fake, target, tail }) => ({
    lane: index, target, tail, ...fake.facts, ended: ended(fake), pendingPlays: fake.pending.length, ahead: fake.ahead,
  })));
}

const laneArb: fc.Arbitrary<LaneSpec> = fc.record({
  start: fc.integer({ min: 0, max: 24 }),
  durationFrames: fc.integer({ min: 6, max: 48 }),
  inFrame: fc.integer({ min: 0, max: 24 }),
  long: fc.boolean(),
  framesInFile: fc.integer({ min: -12, max: 48 }),
  extra: fc.constantFrom(0, 0.0005, 0.001, 0.013, 1 / 48, 0.03),
  initialReadyState: fc.constantFrom<1 | 4>(1, 4),
  skew: fc.constantFrom(0, 0, 0.01, -0.01, 0.025, -0.025),
}).map(({ start, durationFrames, inFrame, long, framesInFile, extra, initialReadyState, skew }) => ({
  start, durationFrames, inFrame, initialReadyState, skew,
  // A short file may end before the clip's first frame, so the lane is in its tail from its start.
  fileSeconds: long ? (inFrame + durationFrames) / FPS + 2 : Math.max(0.05, (inFrame + Math.min(framesInFile, durationFrames)) / FPS + extra),
}));

/**
 * The first frame at which a lane's clip samples past its file end, if inside the clip.
 * @param lane - The lane.
 * @returns The frame, or null when the file covers the clip.
 * @throws {never} Never.
 */
function tailFrame(lane: LaneSpec): number | null {
  const frame = lane.start - lane.inFrame + Math.floor(lane.fileSeconds * FPS + EPSILON) + 1;
  return frame < lane.start + lane.durationFrames ? frame : null;
}

// Two lanes; sometimes the second starts exactly where the first's tail begins, a playback boundary.
const lanesArb: fc.Arbitrary<[LaneSpec, LaneSpec]> = fc.tuple(laneArb, laneArb, fc.boolean()).map(([a, b, align]) => {
  const crossing = tailFrame(a);
  return [a, align && crossing !== null ? { ...b, start: crossing } : b];
});

const laneIndexArb = fc.constantFrom<LaneIndex>(0, 1);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<Command>({ op: 'toggle' }) },
  { weight: 2, arbitrary: fc.nat(1000).map((at): Command => ({ op: 'seek', at })) },
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 120 }).map((ms): Command => ({ op: 'advance', ms })) },
  { weight: 2, arbitrary: laneIndexArb.map((lane): Command => ({ op: 'stall', lane })) },
  { weight: 2, arbitrary: laneIndexArb.map((lane): Command => ({ op: 'recover', lane })) },
  { weight: 3, arbitrary: laneIndexArb.map((lane): Command => ({ op: 'land', lane })) },
  { weight: 2, arbitrary: laneIndexArb.map((lane): Command => ({ op: 'resolve', lane })) },
  { weight: 1, arbitrary: laneIndexArb.map((lane): Command => ({ op: 'timeupdate', lane })) },
  {
    weight: 3,
    arbitrary: fc.tuple(laneIndexArb, fc.double({ min: 0.6, max: 2.5, noNaN: true }), fc.boolean())
      .map(([lane, size, back]): Command => ({ op: 'jump', lane, by: back ? -size : size })),
  },
);

const longLane = (fileSeconds: number): LaneSpec => ({ start: 0, durationFrames: 48, inFrame: 0, fileSeconds, initialReadyState: 4, skew: 0 });
const metadata: Command[] = [{ op: 'land', lane: 0 }, { op: 'land', lane: 1 }];
// Runs that always happen. The second lane's play() settles late, so the first lane runs ahead during the resume step:
// 0.2 s when the preview starts playing; then the same with a stall before, which holds and seeks it back (0.2 s;
// 0.3 s, at its file end), so it must resume in place.
const FIXED_RUNS: Array<[[[LaneSpec, LaneSpec], Command[]], boolean[]]> = [
  [[[longLane(10), longLane(10)], [
    ...metadata, { op: 'toggle' }, { op: 'advance', ms: 100 }, { op: 'advance', ms: 100 }, { op: 'resolve', lane: 1 },
  ]], [false, true]],
  [[[longLane(10), longLane(10)], [
    ...metadata, { op: 'toggle' }, { op: 'advance', ms: 100 }, { op: 'advance', ms: 100 },
    { op: 'stall', lane: 1 }, { op: 'recover', lane: 1 }, { op: 'resolve', lane: 1 },
  ]], [false, true]],
  [[[longLane(0.3), longLane(10)], [
    ...metadata, { op: 'toggle' }, { op: 'advance', ms: 120 }, { op: 'advance', ms: 120 }, { op: 'advance', ms: 120 },
    { op: 'stall', lane: 1 }, { op: 'land', lane: 0 }, { op: 'recover', lane: 1 }, { op: 'resolve', lane: 1 },
  ]], [false, true]],
];

describe('useTimelinePlayback over two video lanes (property)', () => {
  it('holds the wait, tail and resume rules and never stays waiting once every lane is healthy (§6.3, §7.3)', async () => {
    await fc.assert(fc.asyncProperty(
      // The user presses play first, often from a few frames before the first lane's tail; the rest is random.
      fc.tuple(lanesArb, fc.option(fc.integer({ min: 0, max: 8 })), fc.array(commandArb, { minLength: 4, maxLength: 24 }))
        .map(([lanes, lead, rest]): [[LaneSpec, LaneSpec], Command[]] => {
          const crossing = tailFrame(lanes[0]);
          const opening: Command[] = lead === null || crossing === null ? [] : [{ op: 'seek', at: Math.max(0, crossing - lead) }];
          return [lanes, [...opening, { op: 'toggle' }, ...rest]];
        }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
      async ([lanes, commands], lateFlags) => {
        ctx = newContext(lateFlags);
        const document = timelineDocument(lanes);
        const sequenceEnd = Math.max(...lanes.map((lane) => lane.start + lane.durationFrames));
        const hook = renderPlayback(document, lanes);
        ctx.transport = () => hook.result.current.state;
        const seen = new Set<keyof typeof reached>();
        // Seeks a tail lane got in its current stretch of playing in its tail.
        const tailSeeks = new Map<Fake, number>();
        // Lanes that jumped past the hard-sync threshold while playing, and how many ticks they have left to be synced.
        const jumpWatch = new Map<Fake, number>();
        // Lanes whose drift a tick measured since the preview last started playing or the lane was last sought: only
        // for those can a check tell a jump (the first check after has no earlier drift to compare with, design §6.3).
        const measured = new Set<Fake>();
        // A decoder skip asked for by a `jump` command, made on the next tick while a measured lane plays.
        let pendingJump: { lane: LaneIndex; by: number } | null = null;
        const fakeOf = (lane: LaneIndex): Fake | undefined => {
          const element = hook.result.current.videoElement(CLIP_IDS[lane]);
          return element === undefined ? undefined : ctx.byElement.get(element);
        };
        const snapshot = (): Snapshot => ({ state: hook.result.current.state, intent: hook.result.current.intent, frame: hook.result.current.frame });

        const run = async (command: Command): Promise<void> => {
          const before = snapshot();
          const seekCounts = new Map(ctx.fakes.map((fake) => [fake, fake.seeks.length]));
          const fake = 'lane' in command ? fakeOf(command.lane) : undefined;
          // The lane that skipped just before this tick, with how far it moved and its drift then.
          let jumped: { fake: Fake; by: number; drift: number } | null = null;
          // Any lane the decoder skip moved, near its file end too: it may be hard-synced on this tick (design §6.3).
          let skipped: { fake: Fake; by: number } | null = null;
          if (command.op === 'advance' && before.state === 'playing' && pendingJump !== null) {
            const { lane, by } = pendingJump;
            for (const index of [lane, lane === 0 ? 1 : 0] as const) {
              const skipping = fakeOf(index);
              const spec = lanes[index];
              if (skipping === undefined || !measured.has(skipping) || before.frame < spec.start || before.frame >= spec.start + spec.durationFrames) continue;
              const from = skipping.facts.currentTime;
              if (!jump(skipping, by)) continue;
              const { currentTime, duration } = skipping.facts;
              skipped = { fake: skipping, by: currentTime - from };
              const target = targetAt(spec, before.frame);
              // Judged only well inside the file, where neither the clock nor the element is near the tail.
              const inside = target + JUMP_MARGIN < duration && currentTime + JUMP_MARGIN < duration;
              jumped = inside ? { fake: skipping, by: currentTime - from, drift: Math.abs(currentTime - target) } : null;
              pendingJump = null;
              break;
            }
          }
          const ticked = command.op === 'advance' && before.state === 'playing'
            ? ctx.fakes.filter((item) => !item.facts.paused && hasData(item) && item.pending.length === 0)
            : [];
          if (command.op === 'toggle') act(() => hook.result.current.toggle());
          else if (command.op === 'seek') act(() => hook.result.current.seek(command.at % sequenceEnd));
          else if (command.op === 'advance') advance(command.ms);
          else if (fake !== undefined) {
            if (command.op === 'stall') {
              act(() => {
                fake.facts.readyState = Math.min(fake.facts.readyState, 2);
                fake.element.dispatchEvent(new Event('waiting'));
              });
            } else if (command.op === 'recover') recover(fake);
            else if (command.op === 'land') land(fake);
            else if (command.op === 'resolve') {
              if (resolveLate(fake)) seen.add('lateResolve');
            } else if (command.op === 'jump') pendingJump = { lane: command.lane, by: command.by };
            else act(() => fake.element.dispatchEvent(new Event('timeupdate')));
          }
          await flush();
          const after = snapshot();
          const views = visibleLanes(hook, lanes);
          const where = `after ${JSON.stringify(command)}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}, lanes ${describeLanes(views)}`;
          if (after.state === 'playing') seen.add('playing');
          if (after.state === 'waiting') seen.add('waiting');
          if (after.state === 'playing' && views.some((view) => view.tail)) seen.add('tailWhilePlaying');
          if (command.op === 'seek' && before.state === 'playing') seen.add('userSeekWhilePlaying');
          const user = command.op === 'toggle' || command.op === 'seek';
          if (user || (before.state !== 'playing' && after.state === 'playing')) measured.clear();
          if (after.state === 'playing') for (const item of ticked) measured.add(item);
          for (const item of ctx.fakes) if (item.seeks.length > (seekCounts.get(item) ?? 0)) measured.delete(item);

          // Waiting: the clock is held and no visible lane plays, except in the resume step.
          if (before.state === 'waiting' && after.state === 'waiting' && !user) {
            expect(after.frame, `clock moved while waiting ${where}`).toBe(before.frame);
          }
          if (after.state === 'waiting') {
            const resumeStep = views.some((view) => view.fake.pending.length > 0) && views.every((view) => view.tail || hasData(view.fake));
            for (const view of views) {
              expect(view.fake.facts.paused || resumeStep, `lane ${view.index} plays while waiting ${where}`).toBe(true);
            }
          }

          // Tail: never the cause of a wait; while playing, at most one seek, to the file end, and paused.
          if (before.state === 'playing' && after.state === 'waiting' && !user) {
            // A lane hard-synced after a skip is sought to the held frame, which can be its file end, so it then reads as a
            // tail lane; the skip caused that wait, not a tail.
            const resynced = skipped !== null && Math.abs(skipped.by) > HARD_SYNC_SECONDS - JUMP_MARGIN
              && skipped.fake.seeks.length > (seekCounts.get(skipped.fake) ?? 0);
            const cause = resynced || views.some((view) => !view.tail && (view.fake.facts.seeking || view.fake.facts.readyState < 3));
            expect(cause, `playing went to waiting with only tail lanes off ${where}`).toBe(true);
          }
          for (const view of views) {
            const stretch = before.state === 'playing' && after.state === 'playing' && view.tail && !user;
            if (!stretch) {
              tailSeeks.delete(view.fake);
              continue;
            }
            const fresh = view.fake.seeks.slice(seekCounts.get(view.fake) ?? 0);
            if (fresh.length > 0) seen.add('tailSeekWhilePlaying');
            for (const value of fresh) {
              expect(value, `tail seek of lane ${view.index} not to its file end ${where}`).toBeGreaterThanOrEqual(view.fake.facts.duration - END_TOLERANCE);
            }
            const count = (tailSeeks.get(view.fake) ?? 0) + fresh.length;
            tailSeeks.set(view.fake, count);
            expect(count, `lane ${view.index} sought ${count} times in its tail while playing ${where}`).toBeLessThanOrEqual(1);
          }
          // An element still playing its last millisecond is not judged: it ends and pauses on its own.
          if (after.state === 'playing') {
            for (const view of views) {
              if (view.target > view.fake.facts.duration + EPSILON && !atEnd(view.fake)) {
                expect(view.fake.facts.paused, `tail lane ${view.index} plays ${where}`).toBe(true);
              }
            }
          }

          // Resume: every lane not in its tail is within the resume threshold of the clock's source time.
          if (before.state !== 'playing' && after.state === 'playing') {
            if (before.state === 'waiting') seen.add('resumeAfterWait');
            for (const view of views) {
              const { duration, currentTime } = view.fake.facts;
              if (view.target > duration + EPSILON) continue;
              if (view.fake.ahead > 0) seen.add('aheadAtResume');
              const drift = Math.abs(currentTime - view.target);
              expect(drift, `lane ${view.index} resumes ${drift}s off the clock ${where}`).toBeLessThanOrEqual(RESUME_SECONDS + view.fake.ahead + EPSILON);
            }
          }

          // Jump: within two ticks of a jump past the hard-sync threshold (this one included), the preview waits and seeks
          // that lane to the held frame's source time, or the lane is back within the threshold. A user seek or
          // play/pause resyncs anyway; a lane that left the frame, reached its tail or ended is not judged.
          const hit = jumped;
          if (hit !== null && Math.abs(hit.by) > HARD_SYNC_SECONDS + JUMP_MARGIN && hit.drift > HARD_SYNC_SECONDS + JUMP_MARGIN) {
            seen.add('jumpWhilePlaying');
            jumpWatch.set(hit.fake, 2);
          }
          for (const [watched, ticksLeft] of jumpWatch) {
            const view = views.find((item) => item.fake === watched);
            if (user || after.state === 'paused' || view === undefined || view.tail || ended(watched)) {
              jumpWatch.delete(watched);
              continue;
            }
            const fresh = watched.seeks.slice(seekCounts.get(watched) ?? 0);
            const synced = after.state === 'waiting' && fresh.some((value) => Math.abs(value - view.target) <= END_TOLERANCE);
            const back = Math.abs(watched.facts.currentTime - view.target) <= HARD_SYNC_SECONDS + JUMP_MARGIN;
            if (synced || back) {
              jumpWatch.delete(watched);
              continue;
            }
            const left = command.op === 'advance' ? ticksLeft - 1 : ticksLeft;
            expect(left, `lane ${view.index} not hard-synced within two ticks of a jump ${where}`).toBeGreaterThan(0);
            jumpWatch.set(watched, left);
          }
        };

        try {
          for (const command of commands) await run(command);
          // Settle: every element healthy, every play() honoured, then three seconds of time.
          const intent = hook.result.current.intent;
          ctx.immediate = true;
          const heal = async (): Promise<void> => {
            for (const lane of [0, 1] as const) {
              const fake = fakeOf(lane);
              if (fake === undefined) continue;
              // A lane without metadata gets it first; the seek the playback then starts lands next.
              if (fake.facts.readyState === 0) await run({ op: 'land', lane });
              if (fake.facts.seeking) await run({ op: 'land', lane });
              if (fake.facts.readyState < healthyLevel(fake)) await run({ op: 'recover', lane });
              while (fake.pending.some((play) => play.late)) await run({ op: 'resolve', lane });
            }
          };
          await heal();
          for (let elapsed = 0; elapsed < 3000; elapsed += 50) {
            await run({ op: 'advance', ms: 50 });
            await heal();
          }
          await heal();
          const end = snapshot();
          const views = visibleLanes(hook, lanes);
          expect(end.state, `left waiting once every lane is healthy: ${JSON.stringify(end)} (intent ${intent} before settling), lanes ${describeLanes(views)}`).not.toBe('waiting');
          if (intent === 'play' && end.state === 'paused') {
            expect(end.frame, `paused short of the sequence end ${JSON.stringify(end)}`).toBe(sequenceEnd - 1);
          }
        } finally {
          hook.unmount();
        }
        reached.runs += 1;
        for (const key of seen) reached[key] += 1;
      },
    ), { seed: 1410, numRuns: 1000, examples: FIXED_RUNS });
    // The property is not vacuous: each situation it judges happened in some runs.
    console.warn(`use-timeline-playback property coverage: ${JSON.stringify(reached)}`);
    for (const key of ['playing', 'waiting', 'tailWhilePlaying', 'userSeekWhilePlaying', 'tailSeekWhilePlaying', 'resumeAfterWait', 'lateResolve', 'aheadAtResume', 'jumpWhilePlaying'] as const) {
      expect(reached[key], `no run reached ${key}`).toBeGreaterThan(0);
    }
  }, 120_000);

  it('leaves a lane whose held frame is past its file end alone during a hold: no seek beyond its one tail seek (§6.3)', async () => {
    ctx = newContext([false]);
    // Lane 0: a 0.49 s file under a 48-frame clip, its decoder 2.5% slow, so the clock reaches the file end first.
    const lanes: [LaneSpec, LaneSpec] = [
      { start: 0, durationFrames: 48, inFrame: 0, fileSeconds: 0.49, initialReadyState: 4, skew: -0.025 },
      { start: 0, durationFrames: 48, inFrame: 0, fileSeconds: 10, initialReadyState: 4, skew: 0 },
    ];
    const hook = renderPlayback(timelineDocument(lanes), lanes);
    ctx.transport = () => hook.result.current.state;
    const fake = (index: LaneIndex): Fake => ctx.byElement.get(hook.result.current.videoElement(CLIP_IDS[index])!)!;
    try {
      land(fake(0));
      land(fake(1));
      await flush();
      act(() => hook.result.current.toggle());
      await flush();
      expect(hook.result.current.state).toBe('playing');
      const a = fake(0);
      const before = a.seeks.length;
      while ((a.seeks.length === before || hook.result.current.frame < 12) && hook.result.current.frame < 40) {
        advance(1000 / FPS);
        await flush();
      }
      // The clock passed the file end while the element lagged: its one tail seek, still in flight.
      expect(a.seeks.slice(before)).toEqual([0.49]);
      expect(a.facts.seeking).toBe(true);
      // Lane 1 stalls before that seek lands; the next tick holds the preview on a frame past lane 0's file end.
      act(() => {
        fake(1).facts.readyState = 2;
        fake(1).element.dispatchEvent(new Event('waiting'));
      });
      await flush();
      advance(1000 / FPS);
      await flush();
      expect(hook.result.current.state).toBe('waiting');
      expect(targetAt(lanes[0], hook.result.current.frame)).toBeGreaterThan(0.49);
      expect(a.seeks.slice(before)).toEqual([0.49]);
      land(a);
      recover(fake(1));
      await flush();
      for (let step = 0; step < 4; step += 1) {
        advance(1000 / FPS);
        await flush();
      }
      expect(hook.result.current.state).toBe('playing');
      expect(a.seeks.slice(before)).toEqual([0.49]);
    } finally {
      hook.unmount();
    }
  });
});
