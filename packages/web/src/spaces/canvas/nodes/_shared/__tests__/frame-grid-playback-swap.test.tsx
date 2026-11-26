// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 test plan §69 U06 (frames-split design §7.8 `Replace`, §7.9 N and T; browser path B03): while nothing is
 * selected a node plays the original for display only; when P is published the node swaps to P's playback file and keeps
 * where the user paused and whether the user was playing. The renderer is a driver that hands the player a native element
 * on the playback URL.
 */

import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../../../video-presentation/types';
import { PRESENTED, presentedBundle } from '@web/test-utils/video-presentation';

const driver = vi.hoisted(() => ({ sessions: [] as { element: HTMLVideoElement; callbacks: VideoRendererCallbacks }[] }));
import type * as RendererModule from '../../../video-presentation/create-video-renderer';
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    // The original plays for display only through a source without a selected version (§7.8 detached × Attach).
    const presentation = (source as { presentation?: VideoPresentationSource['presentation'] }).presentation;
    element.setAttribute('src', presentation === undefined ? source.canonicalURL : presentation.playback.carrier.url);
    Object.defineProperties(element, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 } });
    host.append(element);
    driver.sessions.push({ element, callbacks });
    return { dispose: () => element.remove() };
  }),
}));

const ORIGINAL = 'https://assets.example.test/node/source.mov';
const PLAYBACK = 'https://assets.example.test/node/playback.mp4';
/** P's grid display (§3.5): 250 frames at 25 fps; the duration is computed from the grid, never stored. */
const DISPLAY = { width: 1920, height: 1080, fps: { numerator: 25, denominator: 1 }, frameCount: 250, gridStart: { numerator: 0, denominator: 1 },
  realFrameCount: 250, leadFrames: 0, holdFrames: 0 };
const DURATION = DISPLAY.frameCount * DISPLAY.fps.denominator / DISPLAY.fps.numerator;
const source: VideoPresentationSource = { canonicalURL: ORIGINAL, sourceFingerprint: PRESENTED.fingerprint, manifest: null,
  presentation: { ...presentedBundle(ORIGINAL, {
    playback: { kind: 'native', carrier: { storageKey: 'node/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } }),
  original: { width: DISPLAY.width, height: DISPLAY.height, duration: DURATION },
  playbackClock: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: DISPLAY.frameCount, step: 1, duration: 1 }] },
  display: DISPLAY } as unknown as VideoPresentationSource['presentation'] };
let times: WeakMap<HTMLMediaElement, number>;
let paused: WeakMap<HTMLMediaElement, boolean>;
let played: HTMLMediaElement[];
let currentTimeDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  driver.sessions = []; times = new WeakMap(); paused = new WeakMap(); played = [];
  currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true,
    get() { return times.get(this as HTMLMediaElement) ?? 0; },
    set(value: number) { times.set(this as HTMLMediaElement, value); (this as HTMLMediaElement).dispatchEvent(new Event('timeupdate')); } });
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement): boolean { return paused.get(this) ?? true; });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement): Promise<void> {
    played.push(this); paused.set(this, false); this.dispatchEvent(new Event('play')); return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement): void { paused.set(this, true); this.dispatchEvent(new Event('pause')); });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (currentTimeDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', currentTimeDescriptor); else Reflect.deleteProperty(HTMLMediaElement.prototype, 'currentTime');
});

/**
 * Renders the node player on the original, positions it at 2.4 s, optionally plays, then publishes P.
 * @param playing - Whether the user pressed play on the original.
 * @returns The playback element the player swapped to.
 */
async function publishAfter(playing: boolean): Promise<HTMLVideoElement> {
  const view = render(<MediaPlayer modality='video' src={ORIGINAL} videoSource={null} />);
  const original = view.container.querySelector<HTMLVideoElement>(`video[src="${ORIGINAL}"]`);
  expect(original, 'with nothing selected the node plays the original for display').not.toBeNull();
  act(() => { original!.currentTime = 2.4; });
  if (playing) fireEvent.click(screen.getByTestId('play-toggle'));
  expect(played.includes(original!)).toBe(playing);
  view.rerender(<MediaPlayer modality='video' src={ORIGINAL} videoSource={source} />);
  const owned = driver.sessions.find((session) => session.element.getAttribute('src') === PLAYBACK);
  if (owned === undefined) throw new Error('No renderer was created for the playback file');
  await act(async () => { owned.callbacks.ready(owned.element, owned.element); owned.element.dispatchEvent(new Event('loadedmetadata')); await Promise.resolve(); });
  return owned.element;
}

describe('U06 publishing P swaps the node to the playback file and keeps transport (§7.8 Replace)', () => {
  it('U06: a paused original at 2.4 s becomes the playback file paused at 2.4 s', async () => {
    const element = await publishAfter(false);
    expect(element.getAttribute('src')).toBe(PLAYBACK);
    expect(times.get(element)).toBe(2.4);
    expect(played).not.toContain(element);
  });

  it('U06: a playing original keeps playing on the playback file from where it was', async () => {
    const element = await publishAfter(true);
    expect(times.get(element)).toBe(2.4);
    expect(played).toContain(element);
  });
});
