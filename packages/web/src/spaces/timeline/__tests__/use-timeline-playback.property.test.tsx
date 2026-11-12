// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Property-based check of the Timeline preview over two video lanes (#1410 design §6.3, §7.3). Each run builds a
 * document with two video clips on two tracks (random start, length, in-point and file duration, the file sometimes
 * shorter than the clip so a tail happens, sometimes not a whole number of frames, sometimes the second clip starting
 * exactly where the first one's tail begins; each element's decoder clock a little off), then has the user press play,
 * often after seeking to a few frames before the first lane's tail, and plays 4 to 24 random commands: play/pause, a
 * user seek, time passing, a lane stalling, recovering, a pending seek landing, a late play() settling, a timeupdate.
 * After each command:
 *
 * - while waiting, the clock does not move and no visible lane plays, except in the resume step (every visible lane in
 *   place and a play() of the resume still pending);
 * - a lane in its tail never turns 'playing' into 'waiting' by itself, gets at most one seek (to its file end) while
 *   playing and stays paused;
 * - when the preview starts playing, every visible lane not in its tail is within `resume_seek_seconds` of the clock's
 *   source time, plus what it played on in the resume step after the last hold (the design starts every lane and
 *   anchors the clock once every play() has settled, so a lane that started first runs ahead by the others' delay).
 *
 * At the end every element is made healthy and time passes: a preview the user wants playing is not left waiting.
 *
 * The fake element follows the browser: a seek sets `seeking` and HAVE_METADATA until `seeked`, clamped to the
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
const { resumeSeekSeconds: RESUME_SECONDS, driftSteerSeconds: EARLY_END_SECONDS } = TIMELINE_PREVIEW_DEFAULTS;
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
  | { op: 'timeupdate'; lane: LaneIndex };

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
const reached = { runs: 0, playing: 0, waiting: 0, tailWhilePlaying: 0, userSeekWhilePlaying: 0, tailSeekWhilePlaying: 0, resumeAfterWait: 0, lateResolve: 0, aheadAtResume: 0 };

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
  const facts: Facts = { paused: true, currentTime: 0, duration: spec.fileSeconds, seeking: false, readyState: spec.initialReadyState, playbackRate: 1 };
  const fake: Fake = { clipId, skew: spec.skew, element, facts, pending: [], seeks: [], ahead: 0 };
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
 * Land an element's pending seek: data at the new position, `seeked`, and `ended` when it landed at the end.
 * @param fake - The element.
 * @throws {Error} When a handler fails.
 */
function land(fake: Fake): void {
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
  if (fake.facts.seeking) return;
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
  framesInFile: fc.integer({ min: 1, max: 48 }),
  extra: fc.constantFrom(0, 0.0005, 0.001, 0.013, 1 / 48, 0.03),
  initialReadyState: fc.constantFrom<1 | 4>(1, 4),
  skew: fc.constantFrom(0, 0, 0.01, -0.01, 0.025, -0.025),
}).map(({ start, durationFrames, inFrame, long, framesInFile, extra, initialReadyState, skew }) => ({
  start, durationFrames, inFrame, initialReadyState, skew,
  fileSeconds: long ? (inFrame + durationFrames) / FPS + 2 : (inFrame + Math.min(framesInFile, durationFrames)) / FPS + extra,
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
);

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
        const fakeOf = (lane: LaneIndex): Fake | undefined => {
          const element = hook.result.current.videoElement(CLIP_IDS[lane]);
          return element === undefined ? undefined : ctx.byElement.get(element);
        };
        const snapshot = (): Snapshot => ({ state: hook.result.current.state, intent: hook.result.current.intent, frame: hook.result.current.frame });

        const run = async (command: Command): Promise<void> => {
          const before = snapshot();
          const seekCounts = new Map(ctx.fakes.map((fake) => [fake, fake.seeks.length]));
          const fake = 'lane' in command ? fakeOf(command.lane) : undefined;
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
            } else act(() => fake.element.dispatchEvent(new Event('timeupdate')));
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
            const cause = views.some((view) => !view.tail && (view.fake.facts.seeking || view.fake.facts.readyState < 3));
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
              const tail = view.target > duration + EPSILON || (atEnd(view.fake) && duration - view.target <= EARLY_END_SECONDS + EPSILON);
              if (tail) continue;
              if (view.fake.ahead > 0) seen.add('aheadAtResume');
              const drift = Math.abs(currentTime - view.target);
              expect(drift, `lane ${view.index} resumes ${drift}s off the clock ${where}`).toBeLessThanOrEqual(RESUME_SECONDS + view.fake.ahead + EPSILON);
            }
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
    ), { seed: 1410, numRuns: 1000 });
    // The property is not vacuous: each situation it judges happened in some runs.
    console.warn(`use-timeline-playback property coverage: ${JSON.stringify(reached)}`);
    for (const key of ['playing', 'waiting', 'tailWhilePlaying', 'userSeekWhilePlaying', 'tailSeekWhilePlaying', 'resumeAfterWait'] as const) {
      expect(reached[key], `no run reached ${key}`).toBeGreaterThan(0);
    }
  }, 120_000);
});
