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
// Every video stand-in of the case.
let videoFixtures: VideoFixture[] = [];

/**
 * Run the queued animation frames at the given clock.
 * @param at - The monotonic time.
 * @throws {never} Never.
 */
function runFrames(at: number, place?: () => void): void {
  // A playing video plays on as the clock moves; a case that needs it elsewhere places it after.
  for (const { facts } of videoFixtures) {
    if (!facts.paused && !facts.seeking && !facts.ended && facts.readyState >= 3 && at > now) {
      facts.currentTime = Math.min(facts.duration, facts.currentTime + (at - now) / 1000 * facts.playbackRate);
    }
  }
  now = at;
  place?.();
  const due = [...queuedFrames.values()];
  queuedFrames.clear();
  act(() => { for (const callback of due) callback(at); });
}

beforeEach(() => {
  now = 0;
  nextFrameId = 0;
  queuedFrames = new Map();
  reported = [];
  videoFixtures = [];
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
  /** The element the video-layer controller gets for each video clip, by clip id (#1410 design §6.2). */
  videos: Readonly<Record<string, VideoFixture>>;
  initialFrame: number;
  /** Hand the hook a new layer array on every frame, as an allocation on every frame of play does. */
  fresh?: boolean;
}

/**
 * A layer as the instance pool hands it to the playback (inner#1711 design §7.4): its role and, for a premounted
 * instance, the frame it is first visible at. `TimelineWebLayer` is to carry both; without a role a layer is visible.
 */
type PooledLayer = TimelineWebLayer & { role?: 'visible' | 'premount' | 'idle'; targetFrame?: number };

// `web_animation.preview_premount_ms` (2000) at 24 fps: video clips premount as far ahead as web copies do.
const VIDEO_PREMOUNT_FRAMES = 48;
const NO_VIDEO_LAYERS: ReadonlyArray<{ clipId: string; fileUrl: string | null; coverUrl: string | null; state: 'loading' | 'ready' | 'failed' }> = [];

/**
 * The video layers the Space hands the playback at a frame (#1410 design §6.2): every video clip covering it or
 * starting within the premount lead after it, bottom-up, each with a ready asset.
 * @param document - The document.
 * @param frame - The current frame.
 * @returns The layers.
 * @throws {never} Never.
 */
function videoLayersAt(document: TimelineDocumentV1, frame: number): Array<{ clipId: string; fileUrl: string | null; coverUrl: string | null; state: 'ready' }> {
  const order = new Map(Object.values(document.tracks).map((track) => [track.id, track.order]));
  return Object.values(document.clips)
    .filter((clip) => clip.kind === 'video' && frame < clip.startFrame + clip.durationFrames && frame >= clip.startFrame - VIDEO_PREMOUNT_FRAMES)
    .sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
    .map((clip) => ({ clipId: clip.id, fileUrl: `https://cdn.test/${clip.id}.mp4`, coverUrl: null, state: 'ready' as const }));
}

/**
 * The element the controller is handed for a video clip.
 * @param videos - The case's video stand-ins by clip id.
 * @param clipId - The clip.
 * @returns Its element.
 * @throws {Error} When the case gave the clip no stand-in.
 */
function mediaOf(videos: Readonly<Record<string, VideoFixture>>, clipId: string): HTMLVideoElement {
  const video = videos[clipId];
  if (video === undefined) throw new Error(`no video stand-in for ${clipId}`);
  return video.media;
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
    const signature = JSON.stringify(layersNow.map((layer: PooledLayer) => [layer.key, layer.clip, layer.fps, layer.role, layer.targetFrame]));
    // With `fresh`, every frame brings a new allocation and so a new layer array even when its content is unchanged.
    const allocation = input.fresh === true ? frame : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer set changes only when its content (or, with `fresh`, the frame) does.
    const webLayers = React.useMemo(() => layersNow, [signature, input.layersAt, allocation]);
    const readyClipIds = React.useMemo(() => new Set(Object.keys(input.document.clips)), [input.document]);
    const latest = React.useRef(input);
    latest.current = input;
    const createMedia = React.useCallback((clipId: string): HTMLVideoElement => mediaOf(latest.current.videos, clipId), []);
    const videoSignature = JSON.stringify(videoLayersAt(input.document, frame));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the video layers change only when their content does.
    const videoLayers = React.useMemo(() => videoLayersAt(input.document, frame), [videoSignature]);
    const playbackInput: PlaybackInput = {
      document: input.document, readyClipIds, frame, onFrame, videoLayers, createMedia,
      enabled: true, webLayers, webLoadTimeoutMs: TIMEOUT_MS,
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
    ? [{ key: `${SRC}:0`, clip, fps: FPS, role: 'visible' as const, player: fixture.player }] : []);
}

describe('bridge handshake', () => {
  it('says hello when an instance attaches and posts no seek before bridge-ready', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 10 });
    expect(sent(fixture)).toEqual([{ type: 'breatic-hello' }]);
    act(() => hook.result.current.seek(20));
    expect(seeks(fixture)).toEqual([]);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
  });

  it('on bridge-ready opens a session and seeks to the latest frame mapped onto the source clock', () => {
    const fixture = playerFixture();
    const clip = web(1, 24, 48, 12);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 24 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
    bridgeReady(fixture);
    const { session, sequence } = lastSeek(fixture);
    reply({ type: 'breatic-frame-ready', session, sequence }, window);
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('waiting');
  });

  it('drops replies of a session a later bridge-ready replaced', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 24 });
    bridgeReady(fixture);
    answerLast(fixture);
    const before = lastSeek(fixture);
    const trimmed = { ...clip, sourceInFrame: 12, durationFrames: 36 };
    hook.rerender({ document: documentOf([trimmed]), layersAt: single(trimmed, fixture), videos: {}, initialFrame: 24 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
    act(() => { fixture.player.dispatchEvent(new Event('error')); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('failed');
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('playing');
  });

  it('fails an instance that sends no bridge-ready within the load timeout', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
    act(() => { vi.advanceTimersByTime(TIMEOUT_MS - 1); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('loading');
    act(() => { vi.advanceTimersByTime(1); });
    expect(hook.result.current.webStates.get(`${SRC}:0`)).toBe('failed');
  });

  it('ignores bridge messages once failed, and a retry returns it to loading with a new hello', () => {
    const fixture = playerFixture();
    const clip = web(1, 0, 48);
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const layers = [{ key: `${SRC}:0`, clip, fps: FPS, role: 'visible' as const, player: fixture.player }];
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
        document, readyClipIds, frame, onFrame: setFrame, videoLayers: NO_VIDEO_LAYERS,
        enabled: true, webLayers: layers, webLoadTimeoutMs: TIMEOUT_MS,
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const hook = renderPlayback({ document: documentOf([clip]), layersAt: single(clip, fixture), videos: {}, initialFrame: 0 });
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
    const video = videoFixture(0);
    const { media } = video;
    const play = vi.mocked(media.play);
    const clip = web(1, 0, 48);
    const hook = renderPlayback({
      document: documentOf([VIDEO, clip]), layersAt: single(clip, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 0,
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
      return shown === undefined ? [] : [{ key: `${SRC}:0`, clip: shown, fps: FPS, role: 'visible' as const, player: fixture.player }];
    };
    const hook = renderPlayback({ document: documentOf([left, right]), layersAt, videos: {}, initialFrame: 0 });
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
  facts: { paused: boolean; currentTime: number; duration: number; seeking: boolean; ended: boolean; readyState: number; networkState: number; error: null; playbackRate: number };
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
  const facts: VideoFixture['facts'] = { paused: true, currentTime, duration: 10, seeking: false, ended: false, readyState: 4, networkState: 1, error: null, playbackRate: 1 };
  const seeks: number[] = [];
  for (const key of ['paused', 'duration', 'seeking', 'ended', 'readyState', 'networkState', 'error'] as const) {
    Object.defineProperty(media, key, { configurable: true, get: () => facts[key] });
  }
  Object.defineProperty(media, 'playbackRate', { configurable: true, get: () => facts.playbackRate, set: (value: number) => { facts.playbackRate = value; } });
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
  const fixture = { media, facts, seeks };
  videoFixtures.push(fixture);
  return fixture;
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
  // The rAF clock leads the decoded video: when the clock reaches the boundary the video shows three frames (0.125 s)
  // earlier, within the 0.15 s a lane may be off when a wait ends without being sought (#1410 design §6.3).
  const LAG_FRAMES = 3;

  /**
   * Play over a video from frame 0 until the clock reaches a web copy starting at frame 24 whose instance has just
   * attached, with the video lagging behind the clock.
   * @param lagSeconds - How far the video is behind the clock when the clock reaches the copy.
   * @returns The hook, the copy's player, the video and how many frames were reported before the boundary.
   * @throws {Error} When rendering fails.
   */
  async function reachNewCopy(lagSeconds = LAG_FRAMES / 24): Promise<{ hook: RenderHookResult<PlaybackResult, HarnessProps>; fixture: PlayerFixture; video: VideoFixture; before: number }> {
    const fixture = playerFixture();
    const video = videoFixture(0);
    const clip = web(1, 24, 48);
    const hook = renderPlayback({
      document: documentOf([VIDEO, clip]), layersAt: single(clip, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 0,
    });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    const before = reported.length;
    runFrames(1000, () => { video.facts.currentTime = 1 - lagSeconds; });
    return { hook, fixture, video, before };
  }

  it('stays on the frame where the copy became visible with the video paused, and plays on once it answers without seeking a video 0.125 s behind', async () => {
    const { hook, fixture, video, before } = await reachNewCopy();
    expect(reported.slice(before)[0]).toBe(24);
    expect(reported.slice(before).filter((frame) => frame < 24)).toEqual([]);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(video.facts.paused).toBe(true);
    expect(video.seeks).toEqual([]);

    bridgeReady(fixture);
    expect(lastSeek(fixture).time).toBe(0);
    answerLast(fixture);
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(video.seeks).toEqual([]);
    expect(vi.mocked(video.media.play)).toHaveBeenCalledTimes(2);
    runFrames(1500);
    expect(reported.slice(before).filter((frame) => frame < 24)).toEqual([]);
    expect(hook.result.current.frame).toBeGreaterThan(24);
  });

  it('seeks a video 0.2 s behind to the held frame while the copy loads, and plays on only once both the copy answered and the video landed', async () => {
    const { hook, fixture, video } = await reachNewCopy(0.2);
    expect(hook.result.current.frame).toBe(24);
    expect(hook.result.current.state).toBe('waiting');
    expect(video.seeks).toEqual([1]);
    bridgeReady(fixture);
    answerLast(fixture);
    await settle();
    expect(hook.result.current.state).toBe('waiting');
    runFrames(1500);
    expect(hook.result.current.frame).toBe(24);
    videoEvent(video, 'seeked', { seeking: false, readyState: 4 });
    await settle();
    expect(hook.result.current.state).toBe('playing');
    runFrames(1750);
    expect(hook.result.current.frame).toBe(30);
  });

  it('stays on the handover frame where a later copy takes over the instance of an earlier one, and passes it once that instance answers', async () => {
    const first = playerFixture();
    const second = playerFixture();
    const earlier = web(1, 0, 48);
    const later = { ...web(2, 24, 48), trackId: V3 };
    // Bottom-up ordinals per source, as the Timeline body keys them: alone, the later copy takes the earlier one's instance.
    const layersAt = (frame: number): TimelineWebLayer[] => [earlier, later]
      .filter((item) => frame >= item.startFrame && frame < item.startFrame + item.durationFrames)
      .map((item, ordinal) => ({ key: `${SRC}:${ordinal}`, clip: item, fps: FPS, role: 'visible' as const, player: ordinal === 0 ? first.player : second.player }));
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, earlier, later]), layersAt,
      videos: { [VIDEO.id]: video }, initialFrame: 30,
    });
    bridgeReady(first);
    bridgeReady(second);
    act(() => hook.result.current.toggle());
    answerLast(first);
    answerLast(second);
    await settle();
    expect(hook.result.current.state).toBe('playing');

    const seeksBefore = video.seeks.length;
    const before = reported.length;
    runFrames(1000, () => { video.facts.currentTime = (48 - LAG_FRAMES) / 24; });
    expect(reported.slice(before)[0]).toBe(48);
    expect(reported.slice(before).filter((frame) => frame < 48)).toEqual([]);
    expect(hook.result.current.frame).toBe(48);
    expect(hook.result.current.state).toBe('waiting');
    expect(video.facts.paused).toBe(true);
    expect(video.seeks).toHaveLength(seeksBefore);
    // The reused instance is sent the later copy's time at the handover frame: (48 - 24) / 24.
    expect(lastSeek(first).time).toBe(1);

    answerLast(first);
    await settle();
    expect(hook.result.current.state).toBe('playing');
    expect(video.seeks).toHaveLength(seeksBefore);
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

describe('premounted and idle instances (inner#1711 design §7.4)', () => {
  // Two seconds at 24 fps, the default lead.
  const LEAD = 48;
  const KEY = `${SRC}:0`;
  // A copy on v2 entering at frame 72 over the main video that runs under it.
  const LATER = web(1, 72, 48);
  // A copy on v2 entering at frame 72 with its in-point at source 3 s. A copy under a higher video stays visible in
  // track order (#1410 design §6.1), so a copy is first visible at its own start.
  const REVEALED = web(2, 72, 168, 72);

  /**
   * The layers the pool hands the playback for one copy with one instance: premounted within the lead before the
   * frame it is first visible at, visible while it shows, idle once it has been loaded and is assigned to nothing.
   * @param clip - The copy.
   * @param fixture - Its instance's player.
   * @param firstVisible - The frame it is first visible at.
   * @returns The layer function.
   * @throws {never} Never.
   */
  function pooled(clip: TimelineWebAnimationClip, fixture: PlayerFixture, firstVisible = clip.startFrame): (frame: number) => TimelineWebLayer[] {
    let loaded = false;
    return (frame) => {
      const base = { key: KEY, clip, fps: FPS, player: fixture.player };
      if (frame >= firstVisible && frame < clip.startFrame + clip.durationFrames) {
        loaded = true;
        return [{ ...base, role: 'visible' } satisfies PooledLayer];
      }
      if (frame < firstVisible && frame >= firstVisible - LEAD) {
        loaded = true;
        return [{ ...base, role: 'premount', targetFrame: firstVisible } satisfies PooledLayer];
      }
      return loaded ? [{ ...base, role: 'idle' } satisfies PooledLayer] : [];
    };
  }

  it('leaves a premounted instance out of the barrier: play goes on over the video while its page still loads', async () => {
    const fixture = playerFixture();
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, LATER]), layersAt: pooled(LATER, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 30,
    });
    expect(sent(fixture)).toEqual([{ type: 'breatic-hello' }]);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.webStates.get(KEY)).toBe('loading');
    expect(hook.result.current.state).toBe('playing');
    expect(video.media.pause).not.toHaveBeenCalled();
  });

  it('positions a premounted instance once per session at the source time of its first visible frame, not the current frame', () => {
    const fixture = playerFixture();
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, REVEALED]), layersAt: pooled(REVEALED, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 30,
    });
    bridgeReady(fixture);
    expect(seeks(fixture).map((seek) => seek.time)).toEqual([3]);
    // Seeks inside the lead reposition only visible instances; the premounted one keeps its single target seek.
    act(() => hook.result.current.seek(31));
    act(() => hook.result.current.seek(40));
    expect(seeks(fixture).map((seek) => seek.time)).toEqual([3]);
    answerLast(fixture);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
    // A new session (a hello after the Space tab is shown again) is positioned at the target once more.
    bridgeReady(fixture);
    expect(seeks(fixture).map((seek) => seek.time)).toEqual([3, 3]);
    const [first, second] = seeks(fixture);
    expect(second?.session).not.toEqual(first?.session);
  });

  it('leaves a premounted instance waiting for its target receipt through frame-by-frame allocations, sends it no frames, and the receipt makes it ready', async () => {
    const fixture = playerFixture();
    const video = videoFixture(1);
    const hook = renderPlayback({
      document: documentOf([VIDEO, REVEALED]), layersAt: pooled(REVEALED, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 24, fresh: true,
    });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    bridgeReady(fixture);
    const target = lastSeek(fixture);
    expect(target.time).toBe(3);
    runFrames(250);
    runFrames(500);
    expect(hook.result.current.frame).toBe(36);
    expect(seeks(fixture)).toEqual([expect.objectContaining({ sequence: target.sequence, time: 3 })]);
    expect(hook.result.current.webStates.get(KEY)).toBe('waiting');
    answerLast(fixture);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
  });

  it('enters a copy that premounted three seconds ahead at its target frame without pausing the video or freezing the clock', async () => {
    const fixture = playerFixture();
    const video = videoFixture(0);
    const hook = renderPlayback({
      document: documentOf([VIDEO, LATER]), layersAt: pooled(LATER, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 0,
    });
    act(() => hook.result.current.toggle());
    await settle();
    runFrames(1000);
    expect(hook.result.current.frame).toBe(24);
    expect(sent(fixture)).toEqual([{ type: 'breatic-hello' }]);
    expect(hook.result.current.state).toBe('playing');
    bridgeReady(fixture);
    expect(lastSeek(fixture).time).toBe(0);
    answerLast(fixture);
    const sequence = lastSeek(fixture).sequence;
    runFrames(3000);
    expect(hook.result.current.frame).toBe(72);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    runFrames(3500);
    expect(hook.result.current.frame).toBe(84);
    expect(hook.result.current.state).toBe('playing');
    expect(video.media.pause).not.toHaveBeenCalled();
    // The receipt it was premounted with stands for the entry frame: entering adds no sequence.
    expect(seeks(fixture).every((seek) => seek.sequence === sequence)).toBe(true);
    expect(reported.filter((frame, index) => index > 0 && frame < (reported[index - 1] ?? 0))).toEqual([]);
  });

  it('replays from the start into a copy whose instance went idle, ready at its entry frame without a pause', async () => {
    const fixture = playerFixture();
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, LATER]), layersAt: pooled(LATER, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 30,
    });
    bridgeReady(fixture);
    answerLast(fixture);
    act(() => hook.result.current.seek(100));
    videoEvent(video, 'seeked', { seeking: false });
    answerLast(fixture);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
    // The copy has played out: its instance is idle from here on and through the replay's first second.
    act(() => hook.result.current.seek(130));
    videoEvent(video, 'seeked', { seeking: false });
    act(() => hook.result.current.seek(0));
    videoEvent(video, 'seeked', { seeking: false });
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    runFrames(1000);
    expect(hook.result.current.frame).toBe(24);
    // Kept from idle into the lead, it is positioned at its entry frame on the page it already loaded.
    expect(lastSeek(fixture).time).toBe(0);
    expect(sent(fixture).filter((message) => message['type'] === 'breatic-hello')).toHaveLength(1);
    answerLast(fixture);
    const pauses = vi.mocked(video.media.pause).mock.calls.length;
    runFrames(3000);
    expect(hook.result.current.frame).toBe(72);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
    expect(hook.result.current.state).toBe('playing');
    runFrames(3500);
    expect(hook.result.current.frame).toBe(84);
    expect(vi.mocked(video.media.pause).mock.calls.length).toBe(pauses);
  });

  it('positions the premounted instance at the reveal frame when a seek goes back from inside the revealed copy into its lead', () => {
    const fixture = playerFixture();
    const hook = renderPlayback({ document: documentOf([REVEALED]), layersAt: pooled(REVEALED, fixture), videos: {}, initialFrame: 100 });
    bridgeReady(fixture);
    expect(lastSeek(fixture).time).toBe(100 / 24);
    answerLast(fixture);
    act(() => hook.result.current.seek(40));
    expect(lastSeek(fixture).time).toBe(3);
    answerLast(fixture);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
  });

  it('repositions only visible instances on a seek, a play start and a pause', async () => {
    const fixture = playerFixture();
    const video = videoFixture(30 / 24);
    const hook = renderPlayback({
      document: documentOf([VIDEO, LATER]), layersAt: pooled(LATER, fixture),
      videos: { [VIDEO.id]: video }, initialFrame: 30,
    });
    bridgeReady(fixture);
    answerLast(fixture);
    expect(seeks(fixture)).toHaveLength(1);
    act(() => hook.result.current.seek(35));
    videoEvent(video, 'seeked', { seeking: false });
    act(() => hook.result.current.toggle());
    await settle();
    act(() => hook.result.current.toggle());
    expect(hook.result.current.state).toBe('paused');
    expect(seeks(fixture)).toHaveLength(1);
    expect(hook.result.current.webStates.get(KEY)).toBe('ready');
  });

  it('sends an idle instance nothing and keeps it out of the barrier', async () => {
    const fixture = playerFixture();
    const video = videoFixture(130 / 24);
    const idle: PooledLayer = { key: KEY, clip: LATER, fps: FPS, player: fixture.player, role: 'idle' };
    const hook = renderPlayback({
      document: documentOf([VIDEO, LATER]), layersAt: () => [idle],
      videos: { [VIDEO.id]: video }, initialFrame: 130,
    });
    bridgeReady(fixture);
    expect(seeks(fixture)).toEqual([]);
    act(() => hook.result.current.toggle());
    await settle();
    expect(hook.result.current.state).toBe('playing');
    runFrames(500);
    expect(seeks(fixture)).toEqual([]);
  });

  it('replays into a copy whose kept instance re-attached after the Space tab was shown again, without pausing the video or freezing the clock', async () => {
    const fixture = playerFixture();
    const video = videoFixture(30 / 24);
    const document = documentOf([VIDEO, LATER]);
    const readyClipIds = new Set(Object.keys(document.clips));
    const layersAt = pooled(LATER, fixture);
    const result: { current: (ReturnType<typeof useTimelinePlayback> & { frame: number }) | null } = { current: null };
    const createMedia = (clipId: string): HTMLVideoElement => mediaOf({ [VIDEO.id]: video }, clipId);

    /**
     * The Timeline body's use of the hook, as a Space tab renders it: the pool's layers follow the frame.
     * @returns Nothing visible.
     * @throws {never} Never.
     */
    function Body(): null {
      const [frame, setFrame] = React.useState(30);
      const layersNow = layersAt(frame);
      const signature = JSON.stringify(layersNow.map((layer: PooledLayer) => [layer.key, layer.clip.id, layer.role, layer.targetFrame]));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer set changes only when its content does.
      const webLayers = React.useMemo(() => layersNow, [signature]);
      const videoSignature = JSON.stringify(videoLayersAt(document, frame));
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the video layers change only when their content does.
      const videoLayers = React.useMemo(() => videoLayersAt(document, frame), [videoSignature]);
      const playback = useTimelinePlayback({
        document, readyClipIds, frame, onFrame: setFrame, videoLayers, createMedia,
        enabled: true, webLayers, webLoadTimeoutMs: TIMEOUT_MS,
      });
      result.current = { ...playback, frame };
      return null;
    }
    const hellos = (): number => sent(fixture).filter((message) => message['type'] === 'breatic-hello').length;
    const current = (): ReturnType<typeof useTimelinePlayback> & { frame: number } => {
      if (result.current === null) throw new Error('not rendered');
      return result.current;
    };
    const view = render(<React.Activity mode='visible'><Body /></React.Activity>);
    // Premounted, loaded and positioned at its entry frame; then shown, and left back to idle before the start.
    bridgeReady(fixture);
    answerLast(fixture);
    act(() => current().seek(100));
    videoEvent(video, 'seeked', { seeking: false });
    answerLast(fixture);
    act(() => current().seek(0));
    videoEvent(video, 'seeked', { seeking: false });
    expect(current().frame).toBe(0);

    view.rerender(<React.Activity mode='hidden'><Body /></React.Activity>);
    view.rerender(<React.Activity mode='visible'><Body /></React.Activity>);
    expect(hellos()).toBe(2);
    // The page answers the new hello: a new session, and an idle instance is sent no position.
    const before = seeks(fixture).length;
    bridgeReady(fixture);
    expect(seeks(fixture)).toHaveLength(before);

    act(() => current().toggle());
    await settle();
    expect(current().state).toBe('playing');
    runFrames(1000);
    expect(current().frame).toBe(24);
    expect(current().state).toBe('playing');
    // Back in the lead, it is positioned once, in the new session, at its entry frame.
    const fresh = seeks(fixture).slice(before);
    expect(fresh.map((seek) => seek.time)).toEqual([0]);
    expect(fresh[0]?.session).not.toEqual(seeks(fixture)[0]?.session);
    answerLast(fixture);
    const pauses = vi.mocked(video.media.pause).mock.calls.length;
    runFrames(3000);
    expect(current().frame).toBe(72);
    expect(current().webStates.get(KEY)).toBe('ready');
    expect(current().state).toBe('playing');
    runFrames(3500);
    expect(current().frame).toBe(84);
    expect(current().state).toBe('playing');
    expect(vi.mocked(video.media.pause).mock.calls.length).toBe(pauses);
    expect(hellos()).toBe(2);
    view.unmount();
  });
});
