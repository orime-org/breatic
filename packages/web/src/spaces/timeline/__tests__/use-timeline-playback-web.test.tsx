// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The host side of the web-animation frame-ready bridge and the ready barrier inside `useTimelinePlayback`
 * (inner#1711 design §7.2, §7.3, §9 preview-instance table).
 *
 * Each visible web instance is a `<hyperframes-player>` whose `iframeElement` runs the page side
 * (`WEB_ANIMATION_BRIDGE_SCRIPT`). The hook says `breatic-hello` when it attaches, opens a session on every
 * `breatic-bridge-ready`, posts `breatic-seek {session, sequence, time}` to the iframe window and counts the
 * instance ready only on a `breatic-frame-ready` from that window for the current session and latest sequence.
 * Play waits until every visible instance that has not failed is ready.
 *
 * The iframe here is an unattached jsdom iframe whose window is a stand-in recording `postMessage`, and replies are
 * message events whose `source` is that window; that the real player and page answer the same way is checked in a
 * real browser.
 */

import * as React from 'react';
import { act, render, renderHook, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TimelineDocumentV1, TimelineTrack, TimelineVideoClip, TimelineVideoSource, TimelineWebAnimationClip } from '@breatic/shared';
import { useTimelinePlayback, type TimelineWebLayer } from '@web/spaces/timeline/use-timeline-playback';

type PlaybackInput = Parameters<typeof useTimelinePlayback>[0];
type PlaybackResult = ReturnType<typeof useTimelinePlayback> & { frame: number };

const FPS = { num: 24, den: 1 };
const SRC = '80000000-0000-4000-8000-000000000001';
const TIMEOUT_MS = 1000;
const MAIN = 'visual-1';
const V2 = 'v2';
const V3 = 'v3';

const VIDEO_SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: '20000000-0000-4000-8000-000000000001',
  timebase: FPS, extentFrames: 240, durationSeconds: '10', durationOrigin: 'registered',
};
const VIDEO: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001', trackId: MAIN, kind: 'video', sourceId: VIDEO_SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 240, rate: { num: 1, den: 1 }, gain: 1, mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};

/**
 * A web copy on v2.
 * @param id - The clip id's last digits.
 * @param startFrame - Its start.
 * @param durationFrames - Its length.
 * @param sourceInFrame - Its in-point in source frames.
 * @returns The clip.
 * @throws {never} Never.
 */
function web(id: number, startFrame: number, durationFrames: number, sourceInFrame = 0): TimelineWebAnimationClip {
  return {
    id: `30000000-0000-4000-8000-0000000001${String(id).padStart(2, '0')}`, trackId: V2, kind: 'web-animation',
    contentBinding: { baseSourceResultId: SRC, operationId: null },
    startFrame, sourceInFrame, durationFrames, rate: { num: 1, den: 1 }, gain: 1, mute: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  };
}

/**
 * A document holding these clips.
 * @param clips - The clips.
 * @returns The document.
 * @throws {never} Never.
 */
function documentOf(clips: Array<TimelineVideoClip | TimelineWebAnimationClip>): TimelineDocumentV1 {
  const tracks: TimelineTrack[] = [{ id: MAIN, kind: 'visual', order: 0 }, { id: V2, kind: 'visual', order: 1 }, { id: V3, kind: 'visual', order: 2 }];
  return {
    schemaVersion: 1,
    settings: { width: 1920, height: 1080, fps: FPS },
    tracks: Object.fromEntries(tracks.map((track) => [track.id, track])),
    clips: Object.fromEntries(clips.map((clip) => [clip.id, clip])),
    sources: { [VIDEO_SOURCE.id]: VIDEO_SOURCE },
    operationReceipts: {},
  };
}

/** One instance's player stand-in: a host element exposing the iframe the bridge runs in. */
interface PlayerFixture {
  player: HTMLElement & { readonly iframeElement: HTMLIFrameElement | null };
  iframe: HTMLIFrameElement;
  /** The iframe's window as the host sees it; it records what the host posts. */
  frameWindow: Window;
  posted: ReturnType<typeof vi.fn>;
}

/**
 * Build a player stand-in whose iframe window records what the host posts. The iframe is never attached, so jsdom
 * fires no load of its own; every load in these cases is one the test dispatches.
 * @returns The player, its iframe, the iframe's window and the recorder.
 * @throws {never} Never.
 */
function playerFixture(): PlayerFixture {
  const iframe = document.createElement('iframe');
  const posted = vi.fn();
  const frameWindow = { postMessage: posted } as unknown as Window;
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => frameWindow });
  const player = document.createElement('hyperframes-player') as PlayerFixture['player'];
  Object.defineProperty(player, 'iframeElement', { configurable: true, get: () => iframe });
  return { player, iframe, frameWindow, posted };
}

/**
 * Messages the host posted to one instance, with their target origins.
 * @param fixture - The instance.
 * @returns The messages.
 * @throws {never} Never.
 */
function sent(fixture: PlayerFixture): Array<Record<string, unknown>> {
  for (const call of fixture.posted.mock.calls) expect(call[1]).toBe('*');
  return fixture.posted.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

/**
 * The seeks the host posted to one instance.
 * @param fixture - The instance.
 * @returns The seeks.
 * @throws {never} Never.
 */
function seeks(fixture: PlayerFixture): Array<{ type: string; session: unknown; sequence: number; time: number }> {
  return sent(fixture).filter((message) => message['type'] === 'breatic-seek') as Array<{ type: string; session: unknown; sequence: number; time: number }>;
}

/**
 * The last seek the host posted.
 * @param fixture - The instance.
 * @returns It.
 * @throws {Error} When there is none.
 */
function lastSeek(fixture: PlayerFixture): { session: unknown; sequence: number; time: number } {
  const last = seeks(fixture).at(-1);
  if (last === undefined) throw new Error('no seek was posted');
  return last;
}

/**
 * Deliver a message to the host as if `source` posted it.
 * @param data - The message.
 * @param source - The posting window.
 * @throws {never} Never.
 */
function reply(data: unknown, source: Window | null): void {
  // A plain event carrying `data` and `source`: jsdom's MessageEvent accepts only a real window as its source.
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: 'null' } });
  act(() => { window.dispatchEvent(event); });
}

/**
 * The page says its bridge is ready.
 * @param fixture - The instance.
 * @throws {never} Never.
 */
function bridgeReady(fixture: PlayerFixture): void {
  reply({ type: 'breatic-bridge-ready' }, fixture.frameWindow);
}

/**
 * The page answers the last seek it was sent.
 * @param fixture - The instance.
 * @throws {Error} When no seek was posted.
 */
function answerLast(fixture: PlayerFixture): void {
  const { session, sequence } = lastSeek(fixture);
  reply({ type: 'breatic-frame-ready', session, sequence }, fixture.frameWindow);
}

let now = 0;
let nextFrameId = 0;
let queuedFrames = new Map<number, FrameRequestCallback>();
// Every frame the hook reported through onFrame, in order.
let reported: number[] = [];

/**
 * Run the queued animation frames at the given clock.
 * @param at - The monotonic time.
 * @throws {never} Never.
 */
function runFrames(at: number): void {
  now = at;
  const due = [...queuedFrames.values()];
  queuedFrames.clear();
  act(() => { for (const callback of due) callback(at); });
}

beforeEach(() => {
  now = 0;
  nextFrameId = 0;
  queuedFrames = new Map();
  reported = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    queuedFrames.set(nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queuedFrames.delete(id); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

interface HarnessProps {
  document: TimelineDocumentV1;
  layersAt: (frame: number) => TimelineWebLayer[];
  video: { clip: TimelineVideoClip; source: TimelineVideoSource; media: HTMLVideoElement } | null;
  initialFrame: number;
}

/**
 * Render the hook as the Timeline body drives it: the visible web layers follow the current frame, and an
 * unchanged layer set keeps its identity.
 * @param props - The case.
 * @returns The hook.
 * @throws {Error} When rendering fails.
 */
function renderPlayback(props: HarnessProps): RenderHookResult<PlaybackResult, HarnessProps> {
  return renderHook((input: HarnessProps): PlaybackResult => {
    const [frame, setFrame] = React.useState(input.initialFrame);
    const onFrame = React.useCallback((value: number): void => { reported.push(value); setFrame(value); }, []);
    const layersNow = input.layersAt(frame);
    const signature = JSON.stringify(layersNow.map((layer) => [layer.key, layer.clip, layer.fps]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer set changes only when its content does.
    const webLayers = React.useMemo(() => layersNow, [signature, input.layersAt]);
    const readyClipIds = React.useMemo(() => new Set(Object.keys(input.document.clips)), [input.document]);
    const playbackInput: PlaybackInput = {
      document: input.document, readyClipIds, frame, onFrame,
      clip: input.video?.clip ?? null, source: input.video?.source ?? null, media: input.video?.media ?? null,
      enabled: true, resourceState: 'ready', webLayers, webLoadTimeoutMs: TIMEOUT_MS,
    };
    return { ...useTimelinePlayback(playbackInput), frame };
  }, { initialProps: props });
}

/**
 * One copy visible over its whole span through one player.
 * @param clip - The copy.
 * @param fixture - Its player.
 * @returns The layer function.
 * @throws {never} Never.
 */
function single(clip: TimelineWebAnimationClip, fixture: PlayerFixture): (frame: number) => TimelineWebLayer[] {
  return (frame) => (frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames
    ? [{ key: `${SRC}:0`, clip, fps: FPS, player: fixture.player }] : []);
}

describe('bridge handshake', () => {
  it('says hello when an instance attaches and posts no seek before bridge-ready', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 10 });
    expect(sent(fixture)).toEqual([{ type: 'breatic-hello' }]);
    act(() => hook.result.current.seek(20));
    expect(seeks(fixture)).toEqual([]);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
  });

  it('on bridge-ready opens a session and seeks to the latest frame mapped onto the source clock', () => {
    const fixture = playerFixture();
    const clip = web(1, 24, 48, 12);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 24 });
    act(() => hook.result.current.seek(48));
    bridgeReady(fixture);
    // sourceIn / sourceFps + (frame - start) / fps * rate = 12/24 + 24/24.
    expect(lastSeek(fixture)).toMatchObject({ time: 1.5 });
    expect(seeks(fixture)).toHaveLength(1);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
  });

  it('counts the instance ready only on the reply to the current session and latest sequence', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    act(() => hook.result.current.seek(10));
    const first = lastSeek(fixture);
    act(() => hook.result.current.seek(20));
    const second = lastSeek(fixture);
    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.session).toBe(first.session);
    reply({ type: 'breatic-frame-ready', session: first.session, sequence: first.sequence }, fixture.frameWindow);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
    reply({ type: 'breatic-frame-ready', session: second.session, sequence: second.sequence }, fixture.frameWindow);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('ready');
  });

  it('ignores a reply that does not come from the instance iframe', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    const { session, sequence } = lastSeek(fixture);
    reply({ type: 'breatic-frame-ready', session, sequence }, window);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
  });

  it('drops replies of a session a later bridge-ready replaced', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    const old = lastSeek(fixture);
    bridgeReady(fixture);
    const fresh = lastSeek(fixture);
    expect(fresh.session).not.toEqual(old.session);
    reply({ type: 'breatic-frame-ready', session: old.session, sequence: old.sequence }, fixture.frameWindow);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
    answerLast(fixture);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('ready');
  });

  it('treats an iframe load as a reload: back to loading, a new hello, and the old session dropped', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    const old = lastSeek(fixture);
    act(() => { fixture.iframe.dispatchEvent(new Event('load')); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
    expect(sent(fixture).filter((message) => message['type'] === 'breatic-hello')).toHaveLength(2);
    reply({ type: 'breatic-frame-ready', session: old.session, sequence: old.sequence }, fixture.frameWindow);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
  });

  it('sends the new position with a higher sequence when the copy mapping changes', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 24 });
    bridgeReady(fixture);
    answerLast(fixture);
    const before = lastSeek(fixture);
    const trimmed = { ...clip, sourceInFrame: 12, durationFrames: 36 };
    hook.rerender({ document: documentOf([trimmed]), layersAt: single(trimmed, fixture), video: null, initialFrame: 24 });
    const after = lastSeek(fixture);
    expect(after.sequence).toBe(before.sequence + 1);
    expect(after.time).toBe(1.5);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
  });
});

describe('failure and retry', () => {
  it('fails an instance whose player reports an error, and leaves it out of the barrier', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    act(() => { fixture.player.dispatchEvent(new Event('error')); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('failed');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('playing');
  });

  it('fails an instance that sends no bridge-ready within the load timeout', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS - 1); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('failed');
  });

  it('ignores bridge messages once failed, and a retry returns it to loading with a new hello', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    act(() => { fixture.player.dispatchEvent(new Event('error')); });
    bridgeReady(fixture);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('failed');
    expect(seeks(fixture)).toEqual([]);
    act(() => hook.result.current.retryWeb(`${SRC}:0`));
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
    expect(sent(fixture).filter((message) => message['type'] === 'breatic-hello')).toHaveLength(2);
  });
});

describe('a Space tab hidden while an instance loads', () => {
  it('attaches the instance again with one new hello when shown, and ends ready without reloading its page', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const layers = [{ key: `${SRC}:0`, clip, fps: FPS, player: fixture.player }];
    const document = documentOf([clip]);
    const readyClipIds = new Set([clip.id]);
    const result: { current: ReturnType<typeof useTimelinePlayback> | null } = { current: null };
    let iframeLoads = 0;
    fixture.iframe.addEventListener('load', () => { iframeLoads += 1; });

    /**
     * The Timeline body's use of the hook, as a Space tab renders it.
     * @returns Nothing visible.
     * @throws {never} Never.
     */
    function Body(): null {
      const [frame, setFrame] = React.useState(0);
      result.current = useTimelinePlayback({
        document, readyClipIds, frame, onFrame: setFrame, clip: null, source: null, media: null,
        enabled: true, resourceState: 'ready', webLayers: layers, webLoadTimeoutMs: TIMEOUT_MS,
      });
      return null;
    }
    const hellos = (): number => sent(fixture).filter((message) => message['type'] === 'breatic-hello').length;
    const view = render(<React.Activity mode='visible'><Body /></React.Activity>);
    expect(hellos()).toBe(1);
    expect(result.current?.webStates.get(`${SRC}:0`)).toBe('loading');

    view.rerender(<React.Activity mode='hidden'><Body /></React.Activity>);
    // The page finishes loading while the tab is hidden; its bridge-ready reaches no listener.
    bridgeReady(fixture);
    view.rerender(<React.Activity mode='visible'><Body /></React.Activity>);
    expect(hellos()).toBe(2);
    expect(result.current?.webStates.get(`${SRC}:0`)).toBe('loading');

    // The page answers the new hello with bridge-ready, then the seek it is sent.
    bridgeReady(fixture);
    answerLast(fixture);
    expect(result.current?.webStates.get(`${SRC}:0`)).toBe('ready');
    expect(hellos()).toBe(2);
    expect(iframeLoads).toBe(0);
    view.unmount();
  });
});

describe('ready barrier', () => {
  it('holds play on web-only frames until the instance answers the play position', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    answerLast(fixture);
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('waiting');
    answerLast(fixture);
    expect(hook.result.current.state).toBe('playing');
  });

  it('while playing sends each frame time with the same sequence and does not wait for replies', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), video: null, initialFrame: 0 });
    bridgeReady(fixture);
    act(() => hook.result.current.toggle());
    answerLast(fixture);
    const playing = lastSeek(fixture);
    const before = seeks(fixture).length;
    runFrames(250);
    runFrames(500);
    expect(hook.result.current.state).toBe('playing');
    expect(hook.result.current.frame).toBe(12);
    const later = seeks(fixture).slice(before);
    expect(later.length).toBeGreaterThan(0);
    for (const seek of later) expect(seek.sequence).toBe(playing.sequence);
    expect(lastSeek(fixture).time).toBe(0.5);
  });

  it('keeps the video paused until the web instance above it answers', () => {
    const fixture = playerFixture();
    const media = document.createElement('video');
    const facts = { paused: true, currentTime: 0, seeking: false, ended: false, readyState: 4, error: null };
    for (const key of Object.keys(facts) as Array<keyof typeof facts>) {
      Object.defineProperty(media, key, { configurable: true, get: () => facts[key], set: (value: never) => { (facts as Record<string, unknown>)[key] = value; } });
    }
    const play = vi.fn(() => { facts.paused = false; return Promise.resolve(); });
    const pause = vi.fn(() => { facts.paused = true; });
    Object.defineProperty(media, 'play', { configurable: true, value: play });
    Object.defineProperty(media, 'pause', { configurable: true, value: pause });
    const clip = web(1, 0, 48);
    const hook = renderPlayback({
      document: documentOf([VIDEO, clip]), layersAt: single(clip, fixture),
      video: { clip: VIDEO, source: VIDEO_SOURCE, media }, initialFrame: 0,
    });
    bridgeReady(fixture);
    act(() => hook.result.current.toggle());
    act(() => { media.dispatchEvent(new Event('canplay')); });
    expect(play).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe('waiting');
    act(() => { media.dispatchEvent(new Event('pause')); });
    expect(play).not.toHaveBeenCalled();
    answerLast(fixture);
    expect(play).toHaveBeenCalled();
  });

  it('plays on across two adjacent copies of one source, reusing the instance and waiting for its answer', async () => {
    const fixture = playerFixture();
    const left = web(1, 0, 24);
    const right = web(2, 24, 24, 24);
    const layersAt = (frame: number): TimelineWebLayer[] => {
      const shown = [left, right].find((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames);
      return shown === undefined ? [] : [{ key: `${SRC}:0`, clip: shown, fps: FPS, player: fixture.player }];
    };
    const hook = renderPlayback({ document: documentOf([left, right]), layersAt, video: null, initialFrame: 0 });
    bridgeReady(fixture);
    act(() => hook.result.current.toggle());
    answerLast(fixture);
    runFrames(1000);
    expect(hook.result.current.frame).toBe(24);
    const handover = lastSeek(fixture);
    expect(handover.time).toBe(1);
    expect(sent(fixture).filter((message) => message['type'] === 'breatic-hello')).toHaveLength(1);
    reply({ type: 'breatic-frame-ready', session: handover.session, sequence: handover.sequence }, fixture.frameWindow);
    await act(async () => { await Promise.resolve(); });
    runFrames(1500);
    expect(hook.result.current.frame).toBeGreaterThan(24);
    expect(hook.result.current.state).toBe('playing');
  });
});

/** A video element stand-in whose native facts the test sets, recording every currentTime it is given. */
interface VideoFixture {
  media: HTMLVideoElement;
  facts: { paused: boolean; currentTime: number; seeking: boolean; ended: boolean; readyState: number; error: null };
  seeks: number[];
}

/**
 * Build a video stand-in: play and pause flip `paused`, and assigning a different currentTime starts a seek.
 * @param currentTime - Where the video stands at first.
 * @returns The element, its facts and the recorded currentTime assignments.
 * @throws {never} Never.
 */
function videoFixture(currentTime: number): VideoFixture {
  const media = document.createElement('video');
  const facts: VideoFixture['facts'] = { paused: true, currentTime, seeking: false, ended: false, readyState: 4, error: null };
  const seeks: number[] = [];
  for (const key of ['paused', 'seeking', 'ended', 'readyState', 'error'] as const) {
    Object.defineProperty(media, key, { configurable: true, get: () => facts[key] });
  }
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get: () => facts.currentTime,
    set: (value: number) => {
      seeks.push(value);
      if (value !== facts.currentTime) facts.seeking = true;
      facts.currentTime = value;
    },
  });
  Object.defineProperty(media, 'play', { configurable: true, value: vi.fn(() => { facts.paused = false; return Promise.resolve(); }) });
  Object.defineProperty(media, 'pause', { configurable: true, value: vi.fn(() => { facts.paused = true; }) });
  return { media, facts, seeks };
}

/**
 * Deliver a native media event after setting the facts it reports.
 * @param fixture - The video.
 * @param event - The event name.
 * @param facts - The facts at that moment.
 * @throws {never} Never.
 */
function videoEvent(fixture: VideoFixture, event: string, facts: Partial<VideoFixture['facts']> = {}): void {
  act(() => {
    Object.assign(fixture.facts, facts);
    fixture.media.dispatchEvent(new Event(event));
  });
}

/**
 * Let the video's play promise settle.
 * @throws {Error} When an update fails.
 */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

describe('holding at a boundary while a web instance is not ready', () => {
  // The rAF clock leads the decoded video: when the clock reaches the boundary the video shows three frames earlier.
  const LAG_FRAMES = 3;

  /**
   * Play over a video from frame 0 until the clock reaches a web copy starting at frame 24 whose instance has just
   * attached, with the video lagging behind the clock.
   * @returns The hook, the copy's player, the video and how many frames were reported before the boundary.
   * @throws {Error} When rendering fails.
   */
  async function reachNewCopy(): Promise<{ hook: RenderHookResult<PlaybackResult, HarnessProps>; fixture: PlayerFixture; video: VideoFixture; before: number }> {
    const fixture = playerFixture();
    const video = videoFixture(0);
    const clip = web(1, 24, 48);
    const hook = renderPlayback({
      document: documentOf([VIDEO, clip]), layersAt: single(clip, fixture),
      video: { clip: VIDEO, source: VIDEO_SOURCE, media: video.media }, initialFrame: 0,
    });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    video.facts.currentTime = (24 - LAG_FRAMES) / 24;
    const before = reported.length;
    runFrames(1000);
    return { hook, fixture, video, before };
  }

  it('stays on the frame where the copy became visible, with the video paused on that frame, and plays on once it answers', async () => {
    const { hook, fixture, video, before } = await reachNewCopy();
    expect(reported.slice(before)[0]).toBe(24);
    expect(reported.slice(before).filter((frame) => frame < 24)).toEqual([]);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(video.facts.paused).toBe(true);
    expect(video.seeks.at(-1)).toBe(1);

    bridgeReady(fixture);
    expect(lastSeek(fixture).time).toBe(0);
    answerLast(fixture);
    videoEvent(video, 'seeked', { seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    runFrames(1500);
    expect(reported.slice(before).filter((frame) => frame < 24)).toEqual([]);
    expect(hook.result.current.frame).toBeGreaterThan(24);
  });

  it('stays on the handover frame where a later copy takes over the instance of an earlier one, and passes it once that instance answers', async () => {
    const first = playerFixture();
    const second = playerFixture();
    const earlier = web(1, 0, 48);
    const later = { ...web(2, 24, 48), trackId: V3 };
    // Bottom-up ordinals per source, as the Timeline body keys them: alone, the later copy takes the earlier one's instance.
    const layersAt = (frame: number): TimelineWebLayer[] => [earlier, later]
      .filter((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames)
      .map((item, ordinal) => ({ key: `${SRC}:${ordinal}`, clip: item, fps: FPS, player: ordinal === 0 ? first.player : second.player }));
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, earlier, later]), layersAt,
      video: { clip: VIDEO, source: VIDEO_SOURCE, media: video.media }, initialFrame: 30,
    });
    bridgeReady(first);
    bridgeReady(second);
    act(() => hook.result.current.toggle());
    answerLast(first);
    answerLast(second);
    await settle();
    expect(hook.result.current.state).toBe('playing');

    video.facts.currentTime = (48 - LAG_FRAMES) / 24;
    const before = reported.length;
    runFrames(1000);
    expect(reported.slice(before)[0]).toBe(48);
    expect(reported.slice(before).filter((frame) => frame < 48)).toEqual([]);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('waiting');
    expect(video.facts.paused).toBe(true);
    expect(video.seeks.at(-1)).toBe(2);
    // The reused instance is sent the later copy's time at the handover frame: (48 - 24) / 24.
    expect(lastSeek(first).time).toBe(1);

    answerLast(first);
    videoEvent(video, 'seeked', { seeking: false });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    runFrames(1500);
    expect(reported.slice(before).filter((frame) => frame < 48)).toEqual([]);
    expect(hook.result.current.frame).toBeGreaterThan(48);
  });

  it('keeps the boundary frame when the user pauses while held there', async () => {
    const { hook, video, before } = await reachNewCopy();
    act(() => hook.result.current.toggle());
    videoEvent(video, 'pause', { paused: true });
    expect(hook.result.current.intent).toBe('pause');
    expect(hook.result.current.state).toBe('paused');
    expect(hook.result.current.frame).toBe(24);
    expect(reported.slice(before).filter((frame) => frame < 24)).toEqual([]);
  });
});
