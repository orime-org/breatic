// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, renderHook, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveTimelineArrangement, type TimelineDocumentV1, type TimelineVideoClip, type TimelineVideoSource } from '@breatic/shared';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';

type PlaybackInput = Parameters<typeof useTimelinePlayback>[0];
type PlaybackResult = ReturnType<typeof useTimelinePlayback> & { frame: number };

interface MediaFacts {
  paused: boolean;
  currentTime: number;
  duration: number;
  seeking: boolean;
  ended: boolean;
  readyState: number;
  error: MediaError | null;
}

interface MediaFixture {
  element: HTMLVideoElement;
  facts: MediaFacts;
  play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  pause: ReturnType<typeof vi.fn<() => void>>;
  load: ReturnType<typeof vi.fn<() => void>>;
  seeks: number[];
}

interface HarnessProps {
  document: TimelineDocumentV1;
  enabled: boolean;
  resourceState: PlaybackInput['resourceState'];
  media: ReadonlyMap<string, HTMLVideoElement>;
  initialFrame: number;
}

interface DeferredPlay {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'video',
  assetId: '20000000-0000-4000-8000-000000000001',
  timebase: { num: 24, den: 1 },
  extentFrames: 240,
  durationSeconds: '10',
  durationOrigin: 'registered',
};
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

let now = 0;
let nextFrameId = 0;
let queuedFrames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  now = 0;
  nextFrameId = 0;
  queuedFrames = new Map();
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
 * @param overrides - The actual media conditions for the case.
 * @returns The element and its controlled native observations.
 * @throws {Error} When a media property cannot be installed.
 */
function mediaFixture(overrides: Partial<MediaFacts> = {}): MediaFixture {
  const element = document.createElement('video');
  const facts: MediaFacts = {
    paused: true, currentTime: 0, duration: 10, seeking: false,
    ended: false, readyState: 4, error: null, ...overrides,
  };
  const seeks: number[] = [];
  for (const key of Object.keys(facts) as (keyof MediaFacts)[]) {
    if (key === 'currentTime') continue;
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
  const play = vi.fn<() => Promise<void>>(() => {
    facts.paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn<() => void>(() => {
    facts.paused = true;
  });
  // HTML load resets native facts and playbackRate; readiness remains at HAVE_NOTHING.
  const load = vi.fn<() => void>(() => {
    Object.assign(facts, { error: null, currentTime: 0, duration: Number.NaN, readyState: 0, paused: true, seeking: false, ended: false });
    element.playbackRate = element.defaultPlaybackRate;
  });
  Object.defineProperty(element, 'play', { configurable: true, value: play });
  Object.defineProperty(element, 'pause', { configurable: true, value: pause });
  Object.defineProperty(element, 'load', { configurable: true, value: load });
  return { element, facts, play, pause, load, seeks };
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
 * @returns A versioned Timeline DTO.
 * @throws {never} Never.
 */
function timelineDocument(clips: TimelineVideoClip[] = [CLIP], sources: TimelineVideoSource[] = [SOURCE]): TimelineDocumentV1 {
  return {
    schemaVersion: 1,
    settings: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
    tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    sources: Object.fromEntries(sources.map((source) => [source.id, source])),
  };
}

/**
 * Render controlled frame input with the current frame's actual clip and source.
 * @param media - The resolved element for the default source, if present.
 * @param overrides - The Project resource and Space state for the case.
 * @param strict - Whether React repeats the resource effect lifecycle.
 * @returns The hook, its input and observed frame writes.
 * @throws {Error} When rendering or the hook fails.
 */
function renderPlayback(
  media: MediaFixture | null,
  overrides: Partial<HarnessProps> = {},
  strict = false,
): RenderHookResult<PlaybackResult, HarnessProps> & { props: HarnessProps; observedFrames: number[] } {
  const props: HarnessProps = {
    document: timelineDocument(), enabled: true, resourceState: 'ready',
    media: new Map(media === null ? [] : [[SOURCE.id, media.element]]),
    initialFrame: 0, ...overrides,
  };
  const observedFrames: number[] = [];
  const hook = renderHook((input: HarnessProps): PlaybackResult => {
    const [frame, setFrame] = React.useState(input.initialFrame);
    const onFrame = React.useCallback((value: number): void => {
      observedFrames.push(value);
      setFrame(value);
    }, []);
    const clips = Object.values(input.document.clips);
    const ready = new Set(resolveTimelineArrangement({ tracks: Object.values(input.document.tracks), clips }).readyClipIds);
    const clip = clips.find((item) => ready.has(item.id) && frame >= item.startFrame
      && frame < item.startFrame + item.durationFrames) ?? null;
    const source = clip === null ? null : input.document.sources[clip.sourceId] ?? null;
    const playback = useTimelinePlayback({
      document: input.document, frame, onFrame, clip, source,
      media: source === null ? null : input.media.get(source.id) ?? null,
      enabled: input.enabled, resourceState: input.resourceState,
    });
    return { ...playback, frame };
  }, { initialProps: props, ...(strict ? { wrapper: React.StrictMode } : {}) });
  return { ...hook, props, observedFrames };
}

/**
 * Run only the frame callbacks requested before this clock observation.
 * @param timestamp - The monotonic time to observe.
 * @throws {Error} When a frame callback fails.
 */
function tick(timestamp: number): void {
  now = timestamp;
  const due = [...queuedFrames.values()];
  queuedFrames.clear();
  act(() => {
    for (const callback of due) callback(timestamp);
  });
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

  it('resumes an already playing buffered seek from current media properties', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    media.pause.mockClear();
    act(() => hook.result.current.seek(48));
    expect(hook.result.current.state).toBe('waiting');
    expect(media.facts.currentTime).toBe(2);
    expect(media.pause).toHaveBeenCalledTimes(0);
    mediaEvent(media, 'seeked', { seeking: false, paused: false, readyState: 4 });
    expect(hook.result.current.state).toBe('playing');
    expect(media.play).toHaveBeenCalledTimes(1);
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

  it('freezes at the actual media time during buffering and rebases on recovery', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    now = 1250;
    mediaEvent(media, 'waiting', { currentTime: 1.25, readyState: 2, paused: false });
    expect(hook.result.current.frame).toBe(30);
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    tick(5000);
    expect(hook.result.current.frame).toBe(30);
    mediaEvent(media, 'canplay', { readyState: 4, seeking: false, paused: false });
    expect(hook.result.current.state).toBe('playing');
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

  it('holds the requested frame while its source element is loading', () => {
    const hook = renderPlayback(null, { resourceState: 'loading' });
    act(() => hook.result.current.toggle());
    expect(hook.result.current.intent).toBe('play');
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('waits when a current video has no native element yet', () => {
    const hook = renderPlayback(null);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
  });

  it('starts the fixed frame once the current loading source arrives', async () => {
    const hook = renderPlayback(null, { resourceState: 'loading' });
    act(() => hook.result.current.toggle());
    tick(4000);
    const media = mediaFixture();
    hook.rerender({ ...hook.props, resourceState: 'ready', media: new Map([[SOURCE.id, media.element]]) });
    await settle();
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

  it('pauses the previous source and waits for the next video at a clip boundary', async () => {
    const sourceB = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002' };
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: sourceB.id, startFrame: 24, durationFrames: 24 };
    const mediaA = mediaFixture();
    const mediaB = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, sourceB]),
      media: new Map([[SOURCE.id, mediaA.element], [sourceB.id, mediaB.element]]),
    });
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(mediaA.facts.paused).toBe(true);
    expect(hook.result.current.state).toBe('waiting');
    tick(3000);
    expect(hook.result.current.frame).toBe(24);
    mediaEvent(mediaA, 'playing', { paused: false, readyState: 4 });
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(mediaB, 'loadeddata', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    tick(3250);
    expect(hook.result.current.frame).toBe(30);
  });

  it('keeps a newer seek target when an old seek event reaches the current element', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    act(() => hook.result.current.seek(48));
    act(() => hook.result.current.seek(96));
    mediaEvent(media, 'seeked', { currentTime: 2, seeking: false });
    expect(hook.result.current.frame).toBe(96);
    expect(hook.result.current.state).toBe('waiting');
    mediaEvent(media, 'seeked', { currentTime: 4, seeking: false });
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
    const sourceB = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002' };
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: sourceB.id, startFrame: 48, durationFrames: 24 };
    const mediaA = mediaFixture();
    const mediaB = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, sourceB]),
      media: new Map([[SOURCE.id, mediaA.element], [sourceB.id, mediaB.element]]),
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

  it('keeps a late play promise from changing a newer source request', async () => {
    const mediaA = mediaFixture();
    const pending = deferredPlay();
    mediaA.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(mediaA);
    act(() => hook.result.current.toggle());
    const mediaB = mediaFixture({ readyState: 0 });
    hook.rerender({ ...hook.props, media: new Map([[SOURCE.id, mediaB.element]]) });
    await act(async () => {
      mediaA.facts.paused = false;
      pending.resolve();
      await pending.promise;
    });
    expect(hook.result.current.state).toBe('waiting');
    expect(mediaA.facts.paused).toBe(true);
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

  it('keeps a late rejection from failing the replacement video', async () => {
    const mediaA = mediaFixture();
    const pending = deferredPlay();
    mediaA.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(mediaA);
    act(() => hook.result.current.toggle());
    const mediaB = mediaFixture();
    hook.rerender({ ...hook.props, media: new Map([[SOURCE.id, mediaB.element]]) });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    await act(async () => {
      pending.reject(new Error('Previous resource was interrupted'));
      await Promise.resolve();
    });
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.intent).toBe('play');
    tick(250);
    expect(hook.result.current.frame).toBe(6);
  });

  it('reports a rejected play request and resumes after an explicit retry', async () => {
    const media = mediaFixture();
    media.play.mockRejectedValueOnce(new Error('Playback was refused'));
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('failed');
    expect(hook.result.current.intent).toBe('pause');
    tick(1000);
    expect(hook.result.current.frame).toBe(0);
    act(() => hook.result.current.retry());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(media.load).toHaveBeenCalledTimes(0);
  });

  it('stops at a current native media error', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    mediaEvent(media, 'error', { currentTime: 1, error: { code: 3, message: 'Decode failed' } as MediaError });
    expect(hook.result.current.state).toBe('failed');
    expect(hook.result.current.intent).toBe('pause');
    expect(media.facts.paused).toBe(true);
    tick(4000);
    expect(hook.result.current.frame).toBe(24);
  });

  it('pauses on resource failure and retains that pause through resource recovery', async () => {
    const media = mediaFixture();
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    await settle();
    tick(1000);
    media.facts.currentTime = 1;
    hook.rerender({ ...hook.props, resourceState: 'failed' });
    expect(hook.result.current.state).toBe('failed');
    expect(hook.result.current.intent).toBe('pause');
    expect(media.facts.paused).toBe(true);
    hook.rerender({ ...hook.props, resourceState: 'ready' });
    mediaEvent(media, 'canplay', { readyState: 4, seeking: false });
    await settle();
    expect(hook.result.current.intent).toBe('pause');
    expect(media.play).toHaveBeenCalledTimes(1);
    tick(4000);
    expect(hook.result.current.frame).toBe(24);
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
    expect(resolveTimelineArrangement({ tracks: Object.values(document.tracks), clips: Object.values(document.clips) }).readyClipIds).toEqual([later.id]);
    const media = mediaFixture({ readyState: 0 });
    const hook = renderPlayback(media, { document });
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

  it('reloads the same errored element and restores its source position, rate, gain and mute before native playback', async () => {
    const clip = { ...CLIP, rate: { num: 2, den: 1 }, durationFrames: 96, sourceInFrame: 24, gain: 0.4, mute: true };
    const media = mediaFixture({ readyState: 0, error: { code: 4, message: 'Media unavailable' } as MediaError });
    media.element.src = 'http://localhost/timeline-retry.mp4';
    const sameUrl = media.element.src;
    const hook = renderPlayback(media, { document: timelineDocument([clip]), initialFrame: 48 });
    expect(hook.result.current.state).toBe('failed');
    act(() => hook.result.current.retry());
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(media.element.src).toBe(sameUrl);
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
    expect(hook.result.current.state).toBe('playing');
    tick(4250);
    expect(hook.result.current.frame).toBe(54);
  });

  it('preserves a user pause through metadata and seek completion after an errored-element reload', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const hook = renderPlayback(media, { initialFrame: 48 });
    act(() => hook.result.current.retry());
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

  it('uses the latest explicit seek during native reload and refuses the old source position', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const hook = renderPlayback(media, { initialFrame: 48 });
    act(() => hook.result.current.retry());
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

  it.each(['resolve', 'reject'] as const)('ignores an old play promise %s after native reload starts a newer play request', async (outcome) => {
    const media = mediaFixture();
    const previous = deferredPlay();
    const current = deferredPlay();
    media.play.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.toggle());
    mediaEvent(media, 'error', { readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    act(() => hook.result.current.retry());
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

  it('keeps a reloaded source promise and old events from changing its replacement video', async () => {
    const sourceB = { ...SOURCE, id: '10000000-0000-4000-8000-000000000002' };
    const first = { ...CLIP, durationFrames: 24 };
    const second = { ...CLIP, id: '30000000-0000-4000-8000-000000000002', sourceId: sourceB.id, startFrame: 24, durationFrames: 24 };
    const mediaA = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const mediaB = mediaFixture({ readyState: 0 });
    const pending = deferredPlay();
    mediaA.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(mediaA, {
      document: timelineDocument([first, second], [SOURCE, sourceB]),
      media: new Map([[SOURCE.id, mediaA.element], [sourceB.id, mediaB.element]]),
    });
    act(() => hook.result.current.retry());
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

  it('releases a native-reload play request on unmount without late clock or listener activity', async () => {
    const media = mediaFixture({ readyState: 0, error: { code: 2, message: 'Network failed' } as MediaError });
    const pending = deferredPlay();
    media.play.mockReturnValueOnce(pending.promise);
    const hook = renderPlayback(media);
    act(() => hook.result.current.retry());
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
