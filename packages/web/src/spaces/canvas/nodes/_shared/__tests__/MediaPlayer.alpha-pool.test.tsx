// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer';
import { MAX_LIVE_ALPHA_RENDERERS } from '../../../video-presentation/create-video-renderer';
import type { VideoPresentationSource } from '../../../video-presentation/types';
import type * as RendererModule from '../../../video-presentation/create-video-renderer';
import { PRESENTED, presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

// A runaway eviction loop would never end, so creations past this bound fail the renderer instead of hanging the test.
const RUNAWAY = 60;
const created = vi.hoisted(() => ({ count: 0 }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof RendererModule>();
  return {
    ...actual,
    createVideoRenderer: vi.fn((...args: Parameters<typeof actual.createVideoRenderer>) => {
      created.count++;
      if (created.count > RUNAWAY) throw new Error('runaway renderer creation');
      return actual.createVideoRenderer(...args);
    }),
  };
});
// The library never finishes initializing here: the pool is what is under test, not VAP.
vi.mock('video-animation-player', () => ({ default: () => ({
  drawFrame: () => {}, initWebGL: () => {}, initTexture: () => {}, initVideoTexture: () => {}, play: () => {}, cancelRequestAnimation: () => {}, destroy: () => {},
}) }));

const packed = { storageKey: 'packed.mp4', url: 'https://assets.example.test/packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
const CANONICAL = 'https://assets.example.test/canonical.webm';
const alpha: VideoPresentationSource = { canonicalURL: CANONICAL, sourceFingerprint: PRESENTED.fingerprint, presentation: presentedBundle(CANONICAL, {
  display: presentedDisplay(160, 240, 250),
  playback: { kind: 'alpha-packed', carrier: packed, manifest: { ...packed, storageKey: 'manifest.json', url: 'https://assets.example.test/manifest.json', contentType: 'application/json' } } }),
manifest: { schemaVersion: 1, packed, packedWidth: 324, packedHeight: 240, colorRect: { x: 0, y: 0, width: 160, height: 240 }, alphaRect: { x: 164, y: 0, width: 160, height: 240 } } };

beforeEach(() => {
  created.count = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

// W9-1: more transparent players than the page pool holds, none able to rest on a cover (a Document Space with nine
// transparent video blocks). An evicted player must not restart on its own, or each new renderer evicts the next one.
describe('more transparent players than the page pool holds', () => {
  it('keeps one renderer per player until the user reaches an evicted one, which then takes the least recently used slot', () => {
    const owners = MAX_LIVE_ALPHA_RENDERERS + 1;
    render(<>{Array.from({ length: owners }, (_, i) => <MediaPlayer key={i} modality='video' src={CANONICAL} videoSource={alpha} />)}</>);
    expect(created.count).toBe(owners);
    const players = screen.getAllByTestId('media-player');
    const resting = players.filter((player) => player.querySelector('[data-video-presentation="detached"]') !== null);
    expect(resting).toHaveLength(1);
    expect(resting[0]!.querySelector('[data-testid="media-skeleton"]')).not.toBeNull();
    fireEvent.pointerEnter(resting[0]!);
    expect(created.count).toBe(owners + 1);
    expect(resting[0]!.querySelector('[data-video-presentation="detached"]')).toBeNull();
    expect(players.filter((player) => player.querySelector('[data-video-presentation="detached"]') !== null)).toHaveLength(1);
  });
});
