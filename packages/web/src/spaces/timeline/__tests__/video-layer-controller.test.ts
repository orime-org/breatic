// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The element side of the video-layer controller (#1410 design §6.2): one `<video>` per visible or premounted video
 * clip, keyed and marked by clip id, created with its file, cover, rate, gain and mute when the clip enters and removed
 * when it leaves, without touching the other clips' elements; and each layer's state for its preview note. Playback
 * timing is covered through the playback hook in `use-timeline-playback.test.tsx`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimelineDocumentV1, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import { createVideoLayerController } from '@web/spaces/timeline/video-layer-controller';

type AssetState = 'loading' | 'ready' | 'failed';

interface ElementFixture {
  element: HTMLVideoElement;
  facts: { currentTime: number; readyState: number; networkState: number; error: MediaError | null };
  pause: ReturnType<typeof vi.fn<() => void>>;
  seeks: number[];
}

const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000001', kind: 'video', assetId: '20000000-0000-4000-8000-000000000001',
  timebase: { num: 24, den: 1 }, extentFrames: 240, durationSeconds: '10', durationOrigin: 'registered',
};
const A: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000001', trackId: 'visual-1', kind: 'video', sourceId: SOURCE.id,
  startFrame: 0, sourceInFrame: 0, durationFrames: 240, rate: { num: 2, den: 1 }, gain: 1.5, mute: false,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const B: TimelineVideoClip = { ...A, id: '30000000-0000-4000-8000-000000000002', trackId: 'v2', rate: { num: 1, den: 2 }, gain: 0.4, mute: true };
const DOCUMENT: TimelineDocumentV1 = {
  schemaVersion: 1,
  settings: { width: 1920, height: 1080, fps: { num: 24, den: 1 } },
  tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 }, v2: { id: 'v2', kind: 'visual', order: 1 } },
  clips: { [A.id]: A, [B.id]: B },
  sources: { [SOURCE.id]: SOURCE },
  operationReceipts: {},
};

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * A video element whose readiness facts the case sets, recording pauses and seeks.
 * @param facts - The facts the element shows once it has taken its src.
 * @returns The element and its records.
 * @throws {never} Never.
 */
function elementFixture(facts: Partial<ElementFixture['facts']> = {}): ElementFixture {
  const element = document.createElement('video');
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
  const pause = vi.fn<() => void>();
  Object.defineProperty(element, 'pause', { configurable: true, value: pause });
  Object.defineProperty(element, 'play', { configurable: true, value: vi.fn(() => Promise.resolve()) });
  Object.defineProperty(element, 'load', { configurable: true, value: vi.fn() });
  return { element, facts: current, pause, seeks };
}

/**
 * A layer as the Space hands it to the controller.
 * @param clipId - The clip.
 * @param state - Its asset state.
 * @returns The layer.
 * @throws {never} Never.
 */
function layer(clipId: string, state: AssetState = 'ready'): { clipId: string; fileUrl: string | null; coverUrl: string | null; state: AssetState } {
  return state === 'ready'
    ? { clipId, fileUrl: `https://cdn.test/${clipId}.mp4`, coverUrl: `https://cdn.test/${clipId}.jpg`, state }
    : { clipId, fileUrl: null, coverUrl: null, state };
}

/**
 * A controller at frame 0 of DOCUMENT whose elements are the given fixtures.
 * @param elements - The element for each clip id.
 * @returns The controller and its change counter.
 * @throws {Error} When a clip has no fixture.
 */
function controllerFor(elements: Readonly<Record<string, ElementFixture>>): { controller: ReturnType<typeof createVideoLayerController>; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const controller = createVideoLayerController({
    document: () => DOCUMENT,
    frame: () => 0,
    onChange,
    createMedia: (clipId: string): HTMLVideoElement => {
      const fixture = elements[clipId];
      if (fixture === undefined) throw new Error(`no element for ${clipId}`);
      return fixture.element;
    },
  });
  return { controller, onChange };
}

describe('createVideoLayerController elements', () => {
  it('creates one element per layer, keyed and marked by clip id, with its file and cover', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id), layer(B.id)]);
    expect(controller.element(A.id)).toBe(a.element);
    expect(controller.element(B.id)).toBe(b.element);
    expect(a.element.getAttribute('data-clip-id')).toBe(A.id);
    expect(b.element.getAttribute('data-clip-id')).toBe(B.id);
    expect(a.element.src).toBe(`https://cdn.test/${A.id}.mp4`);
    expect(a.element.getAttribute('poster')).toBe(`https://cdn.test/${A.id}.jpg`);
    expect(b.element.src).toBe(`https://cdn.test/${B.id}.mp4`);
  });

  it('gives each element its own clip rate, mute and gain, the gain capped at 1', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id), layer(B.id)]);
    expect([a.element.playbackRate, a.element.volume, a.element.muted]).toEqual([2, 1, false]);
    expect([b.element.playbackRate, b.element.volume, b.element.muted]).toEqual([0.5, 0.4, true]);
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
    const a = elementFixture({ readyState: 0, networkState: 3 });
    const { controller } = controllerFor({ [A.id]: a });
    controller.sync([layer(A.id)]);
    expect(controller.states().get(A.id)).toBe('ready');
  });

  it('reports a loading asset as loading, and a failed asset or an element error as failed', () => {
    const a = elementFixture();
    const b = elementFixture();
    const { controller, onChange } = controllerFor({ [A.id]: a, [B.id]: b });
    controller.sync([layer(A.id, 'loading'), layer(B.id, 'failed')]);
    expect(controller.states().get(A.id)).toBe('loading');
    expect(controller.states().get(B.id)).toBe('failed');
    controller.sync([layer(A.id), layer(B.id, 'failed')]);
    expect(controller.states().get(A.id)).toBe('ready');
    const changes = onChange.mock.calls.length;
    a.facts.error = { code: 3, message: 'Decode failed' } as MediaError;
    a.element.dispatchEvent(new Event('error'));
    expect(controller.states().get(A.id)).toBe('failed');
    expect(onChange.mock.calls.length).toBeGreaterThan(changes);
  });

  it('pauses and removes every element on dispose', () => {
    const a = elementFixture();
    const { controller } = controllerFor({ [A.id]: a });
    controller.sync([layer(A.id)]);
    document.body.append(a.element);
    controller.dispose();
    expect(controller.element(A.id)).toBeUndefined();
    expect(a.element.isConnected).toBe(false);
    expect(a.pause).toHaveBeenCalled();
  });
});
