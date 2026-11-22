// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer';
import { videoSurfaceDemanded } from '../../VideoNode';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../../../video-presentation/types';
import type * as RendererModule from '../../../video-presentation/create-video-renderer';
import type { CanvasSessionState } from '@web/stores/canvas-session';
import { PRESENTED, presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

const driver = vi.hoisted(() => ({ sessions: [] as { element: HTMLVideoElement; surface: HTMLCanvasElement; callbacks: VideoRendererCallbacks; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, _source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    const surface = document.createElement('canvas');
    host.append(surface);
    const dispose = vi.fn(() => { surface.remove(); });
    driver.sessions.push({ element, surface, callbacks, dispose });
    return { dispose };
  }),
}));

const packed = { storageKey: 'packed.mp4', url: 'https://assets.example.test/packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
const CANONICAL = 'https://assets.example.test/canonical.webm';
const COVER = 'https://assets.example.test/canonical.webm.cover.png';
const alpha: VideoPresentationSource = { canonicalURL: CANONICAL, sourceFingerprint: PRESENTED.fingerprint, presentation: presentedBundle(CANONICAL, {
  display: presentedDisplay(160, 240, 250),
  playback: { kind: 'alpha-packed', carrier: packed, manifest: { ...packed, storageKey: 'manifest.json', url: 'https://assets.example.test/manifest.json', contentType: 'application/json' } } }),
manifest: { schemaVersion: 1, packed, packedWidth: 324, packedHeight: 240, colorRect: { x: 0, y: 0, width: 160, height: 240 }, alphaRect: { x: 164, y: 0, width: 160, height: 240 } } };

beforeEach(() => {
  driver.sessions = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * The cover image the player shows, if any.
 * @returns The image element.
 */
function coverImage(): HTMLImageElement | null {
  return screen.getByTestId('media-player').querySelector('img');
}

// W9 (option A): Chromium keeps at most 16 live WebGL contexts per page, so a transparent video node holds one only while
// something uses its frames, and rests on its cover (a PNG with alpha) otherwise.
describe('a transparent video node at rest', () => {
  it('shows its cover and holds no renderer until the user reaches the player, then renders through one', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} poster={COVER} restsOnCover />);
    expect(driver.sessions).toHaveLength(0);
    expect(coverImage()).not.toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('media-player'));
    expect(driver.sessions).toHaveLength(1);
  });

  it('starts a renderer straight away when something uses its frames', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} poster={COVER} />);
    expect(driver.sessions).toHaveLength(1);
  });

  it('renders through a renderer at once when it has no cover to rest on', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} restsOnCover />);
    expect(driver.sessions).toHaveLength(1);
  });

  it('falls back to its cover when the page pool releases its renderer, and starts a new one when reached again', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} poster={COVER} restsOnCover />);
    fireEvent.pointerEnter(screen.getByTestId('media-player'));
    const first = driver.sessions[0]!;
    act(() => first.callbacks.ready(first.element, first.surface));
    expect(coverImage()).toBeNull();
    act(() => first.callbacks.evicted?.());
    expect(first.dispose).toHaveBeenCalled();
    expect(coverImage()).not.toBeNull();
    expect(driver.sessions).toHaveLength(1);
    fireEvent.pointerLeave(screen.getByTestId('media-player'));
    fireEvent.pointerEnter(screen.getByTestId('media-player'));
    expect(driver.sessions).toHaveLength(2);
  });

  // W9-1: a player released by the pool never restarts on its own, or nine of them evict each other forever.
  it('rests on its cover when a player that started with a renderer is released by the pool, until the user reaches it', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} poster={COVER} />);
    const first = driver.sessions[0]!;
    act(() => first.callbacks.ready(first.element, first.surface));
    act(() => first.callbacks.evicted?.());
    expect(first.dispose).toHaveBeenCalled();
    expect(driver.sessions).toHaveLength(1);
    expect(coverImage()).not.toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('media-player'));
    expect(driver.sessions).toHaveLength(2);
  });

  it('rests on the loading placeholder when a player with no cover (a Document video block) is released, and wakes on pointer enter', () => {
    render(<MediaPlayer modality='video' src={CANONICAL} videoSource={alpha} />);
    const first = driver.sessions[0]!;
    act(() => first.callbacks.ready(first.element, first.surface));
    expect(screen.queryByTestId('media-skeleton')).toBeNull();
    act(() => first.callbacks.evicted?.());
    expect(driver.sessions).toHaveLength(1);
    expect(screen.getByTestId('media-skeleton')).not.toBeNull();
    fireEvent.pointerEnter(screen.getByTestId('media-player'));
    expect(driver.sessions).toHaveLength(2);
  });
});

describe('which canvas surfaces use a video node’s frames', () => {
  const base = { panelHostId: null, miniTool: null, focusCrop: null } as unknown as CanvasSessionState;
  it('a tool panel open on the node and a focus crop on the node use them; anything else does not', () => {
    expect(videoSurfaceDemanded(base, 'node')).toBe(false);
    expect(videoSurfaceDemanded({ ...base, panelHostId: 'node', miniTool: {} } as unknown as CanvasSessionState, 'node')).toBe(true);
    expect(videoSurfaceDemanded({ ...base, panelHostId: 'node', miniTool: null } as unknown as CanvasSessionState, 'node')).toBe(false);
    expect(videoSurfaceDemanded({ ...base, panelHostId: 'other', miniTool: {} } as unknown as CanvasSessionState, 'node')).toBe(false);
    expect(videoSurfaceDemanded({ ...base, focusCrop: { nodeId: 'node' } } as unknown as CanvasSessionState, 'node')).toBe(true);
  });
});
