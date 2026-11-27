// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The element side of the media-layer controller (#1410 design §6.2; inner#1709 design §5.2, §7.4, §7.5, renamed from
 * `video-layer-controller.ts`): one `<video>` per visible or premounted video clip and one `<audio>` per audible or
 * premounted audio clip, keyed and marked by clip id, created with its file, cover and rate when the clip enters and
 * removed when it leaves, without touching the other clips' elements; and each layer's state for its preview note.
 *
 * Sound goes through Web Audio: once the preview's `AudioContext` is attached, each video and audio lane is
 * `createMediaElementSource(element)` → `GainNode` → `destination`, the gain `mute ? 0 : min(gain, TIMELINE_MAX_GAIN)`,
 * and the element itself stays at volume 1, unmuted. A lane that leaves, and every lane on dispose, first disconnects
 * its nodes, then pauses, clears its `src`, calls `load()` and is removed. Playback timing is covered through the
 * playback hook in `use-timeline-playback.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimelineDocumentV1, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import { createMediaLayerController } from '@web/spaces/timeline/media-layer-controller';

type LaneKind = 'video' | 'audio';

interface ElementFixture {
  element: HTMLMediaElement;
  facts: { currentTime: number; readyState: number; networkState: number; error: MediaError | null };
  pause: ReturnType<typeof vi.fn<() => void>>;
  load: ReturnType<typeof vi.fn<() => void>>;
  seeks: number[];
}

/** +12 dB as a linear gain, the export renderer's ceiling (design §2.3); written out so it does not come from the code. */
const MAX_GAIN = 10 ** (12 / 20);

const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', url: 'https://cdn.example/assets/clip.mp4', coverUrl: null,
  name: 'clip.mp4', mimeType: 'video/mp4', width: 1920, height: 1080, timebase: { num: 24, den: 1 }, extentFrames: 240, durationSeconds: '10', durationOrigin: 'registered',
};
const AUDIO_SOURCE = {
  id: '10000000-0000-4000-8000-000000000002', kind: 'audio', url: 'https://cdn.example/assets/voice.mp3', name: 'voice.mp3', mimeType: 'audio/mpeg',
  timebase: SOURCE.timebase, extentFrames: SOURCE.extentFrames, durationSeconds: SOURCE.durationSeconds, durationOrigin: SOURCE.durationOrigin,
};
const A: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001', trackId: 'visual-1', kind: 'video', sourceId: SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 240, rate: { num: 2, den: 1 }, gain: 1.5, mute: false,
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const B: TimelineVideoClip = { ...A, id: '30000000-0000-4000-8000-000000000002', trackId: 'v2', rate: { num: 1, den: 2 }, gain: 0.4, mute: true };
// A sound written above the ceiling by a peer, and one in range.
const LOUD = { ...A, id: '30000000-0000-4000-8000-000000000003', trackId: 'v3', kind: 'audio', sourceId: AUDIO_SOURCE.id, rate: { num: 1, den: 1 }, gain: 5, mute: false };
const SOFT = { ...LOUD, id: '30000000-0000-4000-8000-000000000004', trackId: 'v4', gain: 2.5 };
const DOCUMENT = {
  schemaVersion: 3,
  settings: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
  tracks: { 'visual-1': { id: 'visual-1', order: 0 }, v2: { id: 'v2', order: 1 }, v3: { id: 'v3', order: 2 }, v4: { id: 'v4', order: 3 } },
  clips: { [A.id]: A, [B.id]: B, [LOUD.id]: LOUD, [SOFT.id]: SOFT },
  sources: { [SOURCE.id]: SOURCE, [AUDIO_SOURCE.id]: AUDIO_SOURCE },
} as unknown as TimelineDocumentV1;

/** One recorded Web Audio node. */
interface FakeNode { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
interface FakeGain extends FakeNode { gain: { value: number } }
interface FakeSource extends FakeNode { mediaElement: HTMLMediaElement; gainNode: () => FakeGain | undefined }

/** An `AudioContext` that records the graph built in it. */
class FakeAudioContext {
  state: AudioContextState = 'running';
  readonly destination = { kind: 'destination' };
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  readonly log: string[];

  /**
   * Share one call log with the elements.
   * @param log - The log.
   */
  constructor(log: string[]) { this.log = log; }

  /**
   * Record a source node for an element.
   * @param mediaElement - The element.
   * @returns The node.
   */
  createMediaElementSource(mediaElement: HTMLMediaElement): FakeSource {
    const clipId = mediaElement.getAttribute('data-clip-id') ?? '?';
    let target: FakeGain | undefined;
    const node: FakeSource = {
      mediaElement,
      gainNode: () => target,
      connect: vi.fn((next: FakeGain) => { target = next; return next; }),
      disconnect: vi.fn(() => { this.log.push(`source.disconnect:${clipId}`); }),
    };
    this.sources.push(node);
    return node;
  }

  /**
   * Record a gain node.
   * @returns The node.
   */
  createGain(): FakeGain {
    const index = this.gains.length;
    const node: FakeGain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn(() => { this.log.push(`gain.disconnect:${index}`); }) };
    this.gains.push(node);
    return node;
  }

  /**
   * The source node made for a clip's element.
   * @param clipId - The clip.
   * @returns The node, if one was made.
   */
  sourceOf(clipId: string): FakeSource | undefined {
    return this.sources.find((node) => node.mediaElement.getAttribute('data-clip-id') === clipId);
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * A media element whose readiness facts the case sets, recording pauses, loads and seeks.
 * @param kind - A `<video>` or an `<audio>`.
 * @param log - The call log shared with the audio graph.
 * @param facts - The facts the element shows once it has taken its src.
 * @returns The element and its records.
 * @throws {never} Never.
 */
function elementFixture(kind: LaneKind = 'video', log: string[] = [], facts: Partial<ElementFixture['facts']> = {}): ElementFixture {
  const element = document.createElement(kind);
  const current: ElementFixture['facts'] = { currentTime: 0, readyState: 4, networkState: 1, error: null, ...facts };
  const seeks: number[] = [];
  for (const key of ['readyState', 'networkState', 'error'] as const) {
    Object.defineProperty(element, key, { configurable: true, get: () => current[key] });
  }
  Object.defineProperty(element, 'paused', { configurable: true, get: () => true });
  Object.defineProperty(element, 'currentTime', {
    configurable: true,
    get: () => current.currentTime,
    set: (value: number) => { seeks.push(value); current.currentTime = value; },
  });
  const id = (): string => element.getAttribute('data-clip-id') ?? '?';
  const pause = vi.fn<() => void>(() => { log.push(`pause:${id()}`); });
  const load = vi.fn<() => void>(() => { log.push(`load:${id()}:${element.getAttribute('src') ?? ''}`); });
  Object.defineProperty(element, 'pause', { configurable: true, value: pause });
  Object.defineProperty(element, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
  Object.defineProperty(element, 'load', { configurable: true, value: load });
  const remove = element.remove.bind(element);
  Object.defineProperty(element, 'remove', { configurable: true, value: () => { log.push(`remove:${id()}`); remove(); } });
  return { element, facts: current, pause, load, seeks };
}

/**
 * A layer as the Space hands it to the controller.
 * @param clipId - The clip.
 * @param kind - Whether it is a video or a sound.
 * @returns The layer, read from the address its source holds (inner#2171).
 * @throws {never} Never.
 */
function layer(clipId: string, kind: LaneKind = 'video'): { clipId: string; kind: LaneKind; fileUrl: string; coverUrl: string | null } {
  return { clipId, kind, fileUrl: `https://cdn.test/${clipId}.${kind === 'video' ? 'mp4' : 'mp3'}`, coverUrl: kind === 'video' ? `https://cdn.test/${clipId}.jpg` : null };
}

/**
 * A controller at frame 0 of DOCUMENT whose elements are the given fixtures.
 * @param elements - The element for each clip id.
 * @returns The controller, its change counter and the kinds it asked elements for.
 * @throws {Error} When a clip has no fixture.
 */
function controllerFor(elements: Readonly<Record<string, ElementFixture>>): {
  controller: ReturnType<typeof createMediaLayerController>; onChange: ReturnType<typeof vi.fn>; asked: Array<[string, unknown]>;
} {
  const onChange = vi.fn();
  const asked: Array<[string, unknown]> = [];
  const controller = createMediaLayerController({
    document: () => DOCUMENT,
    onChange,
    createMedia: (clipId: string, kind?: unknown): HTMLMediaElement => {
      asked.push([clipId, kind]);
      const fixture = elements[clipId];
      if (fixture === undefined) throw new Error(`no element for ${clipId}`);
      return fixture.element;
    },
  });
  return { controller, onChange, asked };
}

describe('createMediaLayerController elements', () => {
  it('creates one element per layer, keyed and marked by clip id, with its file and cover', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id), layer(B.id)]);
    expect(controller.element(A.id)).toBe(a.element);
    expect(controller.element(B.id)).toBe(b.element);
    expect(a.element.getAttribute('data-clip-id')).toBe(A.id);
    expect(b.element.getAttribute('data-clip-id')).toBe(B.id);
    expect(a.element.getAttribute('poster')).toBe(`https://cdn.test/${A.id}.jpg`);
    expect(new URL(a.element.src).pathname).toBe(`/${A.id}.mp4`);
    expect(new URL(b.element.src).pathname).toBe(`/${B.id}.mp4`);
  });

  it('asks for an audio element for a sound and reads it in CORS mode through the cache-busted address (design §5.2)', () => {
    const loud = elementFixture('audio');
    const a = elementFixture();
    const { controller, asked } = controllerFor({ [A.id]: a, [LOUD.id]: loud });
    controller.sync([layer(A.id), layer(LOUD.id, 'audio')]);
    expect(asked).toEqual([[A.id, 'video'], [LOUD.id, 'audio']]);
    expect(controller.element(LOUD.id)).toBe(loud.element);
    expect(loud.element.getAttribute('data-clip-id')).toBe(LOUD.id);
    for (const element of [a.element, loud.element]) expect(element.crossOrigin).toBe('anonymous');
    const src = new URL(loud.element.src);
    expect(`${src.origin}${src.pathname}`).toBe(`https://cdn.test/${LOUD.id}.mp3`);
    expect(src.searchParams.get('cors')).toBe('1');
  });

  it('gives each element its own clip rate and leaves its volume at 1 and unmuted, gain and mute going to Web Audio (design §5.2)', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id), layer(B.id)]);
    expect([a.element.playbackRate, a.element.volume, a.element.muted]).toEqual([2, 1, false]);
    expect([b.element.playbackRate, b.element.volume, b.element.muted]).toEqual([0.5, 1, false]);
  });

  it('adds a clip\'s element without pausing, seeking or replacing the element already there', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id)]);
    const pauses = a.pause.mock.calls.length;
    controller.sync([layer(A.id), layer(B.id)]);
    expect(controller.element(A.id)).toBe(a.element);
    expect(a.pause).toHaveBeenCalledTimes(pauses);
    expect(a.seeks).toEqual([]);
  });

  it('removes the element of a clip that leaves and leaves the other clip\'s element alone', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id), layer(B.id)]);
    // Each video layer mounts its clip's element in its own box.
    const box = document.createElement('div');
    document.body.append(box);
    box.append(a.element, b.element);
    const pauses = b.pause.mock.calls.length;
    controller.sync([layer(B.id)]);
    expect(controller.element(A.id)).toBeUndefined();
    expect(a.element.isConnected).toBe(false);
    expect(controller.element(B.id)).toBe(b.element);
    expect(b.element.isConnected).toBe(true);
    expect(b.pause).toHaveBeenCalledTimes(pauses);
    expect(b.seeks).toEqual([]);
  });

  it('does not count networkState 3 with no error right after src as a failure', () => {
    const a = elementFixture('video', [], { readyState: 0, networkState: 3 });
    const { controller } = controllerFor({ [A.id]: a });
    controller.sync([layer(A.id)]);
    expect(controller.states().get(A.id)).toBe('ready');
  });

  it('reports a lane as ready, and as failed once its element errors, for a sound too', () => {
    const a = elementFixture();
    const loud = elementFixture('audio');
    const { controller, onChange } = controllerFor({ [A.id]: a, [LOUD.id]: loud });
    controller.sync([layer(A.id), layer(LOUD.id, 'audio')]);
    expect(controller.states().get(A.id)).toBe('ready');
    expect(controller.states().get(LOUD.id)).toBe('ready');
    const changes = onChange.mock.calls.length;
    a.facts.error = { code: 3, message: 'Decode failed' } as MediaError;
    a.element.dispatchEvent(new Event('error'));
    loud.facts.error = { code: 2, message: 'CORS refused' } as MediaError;
    loud.element.dispatchEvent(new Event('error'));
    expect(controller.states().get(A.id)).toBe('failed');
    expect(controller.states().get(LOUD.id)).toBe('failed');
    expect(onChange.mock.calls.length).toBeGreaterThan(changes);
  });

  it('pauses, releases and removes every element on dispose', () => {
    const a = elementFixture();
    const { controller } = controllerFor({ [A.id]: a });
    controller.sync([layer(A.id)]);
    document.body.append(a.element);
    controller.dispose();
    expect(controller.element(A.id)).toBeUndefined();
    expect(a.element.isConnected).toBe(false);
    expect(a.pause).toHaveBeenCalled();
    expect(a.element.getAttribute('src')).toBe(null);
    expect(a.load).toHaveBeenCalled();
  });
});

describe('createMediaLayerController audio graph (design §5.2, §7.4, §7.5)', () => {
  it('connects nothing before an AudioContext is attached', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const a = elementFixture('video', log);
    const { controller } = controllerFor({ [A.id]: a });
    controller.sync([layer(A.id)]);
    expect(context.sources).toHaveLength(0);
  });

  it('connects every existing video and audio lane through its own GainNode to the destination when the context is attached', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const fixtures = { [A.id]: elementFixture('video', log), [B.id]: elementFixture('video', log), [LOUD.id]: elementFixture('audio', log), [SOFT.id]: elementFixture('audio', log) };
    const { controller } = controllerFor(fixtures);
    controller.sync([layer(A.id), layer(B.id), layer(LOUD.id, 'audio'), layer(SOFT.id, 'audio')]);
    controller.attachAudio(context as unknown as AudioContext);
    expect(context.sources.map((node) => node.mediaElement)).toEqual(expect.arrayContaining(Object.values(fixtures).map((fixture) => fixture.element)));
    expect(context.sources).toHaveLength(4);
    for (const node of context.sources) {
      const gain = node.gainNode();
      expect(gain).toBeDefined();
      expect(context.gains).toContain(gain);
      expect(gain?.connect).toHaveBeenCalledWith(context.destination);
    }
  });

  it('sets each gain to the clip gain, 0 when muted, and never above +12 dB', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const { controller } = controllerFor({ [A.id]: elementFixture('video', log), [B.id]: elementFixture('video', log), [LOUD.id]: elementFixture('audio', log), [SOFT.id]: elementFixture('audio', log) });
    controller.sync([layer(A.id), layer(B.id), layer(LOUD.id, 'audio'), layer(SOFT.id, 'audio')]);
    controller.attachAudio(context as unknown as AudioContext);
    expect(context.sourceOf(A.id)?.gainNode()?.gain.value).toBe(1.5);
    expect(context.sourceOf(B.id)?.gainNode()?.gain.value).toBe(0);
    expect(context.sourceOf(SOFT.id)?.gainNode()?.gain.value).toBe(2.5);
    expect(context.sourceOf(LOUD.id)?.gainNode()?.gain.value).toBeCloseTo(MAX_GAIN, 6);
  });

  it('connects a lane created after the context was attached when it is created', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const loud = elementFixture('audio', log);
    const { controller } = controllerFor({ [A.id]: elementFixture('video', log), [LOUD.id]: loud });
    controller.sync([layer(A.id)]);
    controller.attachAudio(context as unknown as AudioContext);
    expect(context.sources).toHaveLength(1);
    controller.sync([layer(A.id), layer(LOUD.id, 'audio')]);
    expect(context.sourceOf(LOUD.id)?.mediaElement).toBe(loud.element);
    expect(context.sources).toHaveLength(2);
  });

  it('disconnects a leaving lane\'s source and gain, then pauses, clears its src, loads and removes the element', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const loud = elementFixture('audio', log);
    const { controller } = controllerFor({ [A.id]: elementFixture('video', log), [LOUD.id]: loud });
    controller.sync([layer(A.id), layer(LOUD.id, 'audio')]);
    controller.attachAudio(context as unknown as AudioContext);
    document.body.append(loud.element);
    log.splice(0);
    controller.sync([layer(A.id)]);
    const source = context.sourceOf(LOUD.id);
    expect(source?.disconnect).toHaveBeenCalled();
    expect(source?.gainNode()?.disconnect).toHaveBeenCalled();
    const steps = log.filter((entry) => entry.endsWith(LOUD.id) || entry.startsWith('gain.') || entry.startsWith(`load:${LOUD.id}`));
    const at = (prefix: string): number => steps.findIndex((entry) => entry.startsWith(prefix));
    expect(at('source.disconnect')).toBeGreaterThanOrEqual(0);
    expect(at('gain.disconnect')).toBeGreaterThanOrEqual(0);
    expect(at('pause')).toBeGreaterThan(Math.max(at('source.disconnect'), at('gain.disconnect')));
    expect(at(`load:${LOUD.id}:`)).toBeGreaterThan(at('pause'));
    expect(log.find((entry) => entry.startsWith(`load:${LOUD.id}`))).toBe(`load:${LOUD.id}:`);
    expect(at('remove')).toBeGreaterThan(at(`load:${LOUD.id}:`));
    expect(loud.element.isConnected).toBe(false);
    expect(context.sourceOf(A.id)?.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects every lane\'s nodes and releases every element on dispose', () => {
    const log: string[] = [];
    const context = new FakeAudioContext(log);
    const fixtures = { [A.id]: elementFixture('video', log), [LOUD.id]: elementFixture('audio', log) };
    const { controller } = controllerFor(fixtures);
    controller.sync([layer(A.id), layer(LOUD.id, 'audio')]);
    controller.attachAudio(context as unknown as AudioContext);
    controller.dispose();
    for (const node of context.sources) {
      expect(node.disconnect).toHaveBeenCalled();
      expect(node.gainNode()?.disconnect).toHaveBeenCalled();
    }
    for (const fixture of Object.values(fixtures)) {
      expect(fixture.element.getAttribute('src')).toBe(null);
      expect(fixture.load).toHaveBeenCalled();
    }
  });
});
