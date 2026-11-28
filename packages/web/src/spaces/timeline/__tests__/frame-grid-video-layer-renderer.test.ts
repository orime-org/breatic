// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * frames-split design §7.14 Ts (assign / error / release) for a Timeline video layer playing a selected version: the
 * layer plays through the canvas renderer on the lane's own element and mounts the renderer's host; another version is a
 * new lane whose old renderer is released first; a renderer failure fails the layer, and its retry starts a new renderer
 * that an old report can no longer fail.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineDocumentV1, TimelineVideoClip, TimelineVideoSource } from '@breatic/shared';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { corsUrl } from '@web/lib/cors-url';
import { createMediaLayerController, type TimelineMediaLayer } from '@web/spaces/timeline/media-layer-controller';
import { presentedBundle } from '@web/test-utils/video-presentation';
import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';

const driver = vi.hoisted(() => ({ made: [] as { host: HTMLElement; source: VideoPresentationSource; callbacks: VideoRendererCallbacks; video: HTMLVideoElement | undefined; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks, video?: HTMLVideoElement) => {
    const dispose = vi.fn();
    driver.made.push({ host, source, callbacks, video, dispose });
    return { dispose };
  }),
}));

const SOURCE: TimelineVideoSource = { id: '10000000-0000-4000-8000-000000000031', kind: 'video', url: 'https://cdn.test/original.mov', coverUrl: null, name: 'original.mov', mimeType: 'video/quicktime', width: 1280, height: 720, timebase: { num: 24, den: 1 }, extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered' };
const CLIP: TimelineVideoClip = { id: '30000000-0000-4000-8000-000000000031', trackId: 'visual-1', kind: 'video', sourceId: SOURCE.id, startFrame: 0, sourceInFrame: 0, durationFrames: 48,
  rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
const DOCUMENT: TimelineDocumentV1 = { schemaVersion: 2, settings: { width: 1920, height: 1080, fps: { num: 24, den: 1 } }, tracks: { 'visual-1': { id: 'visual-1', kind: 'visual', order: 0 } },
  clips: { [CLIP.id]: CLIP }, sources: { [SOURCE.id]: SOURCE } } as unknown as TimelineDocumentV1;
const ORIGINAL = 'https://cdn.test/original.mov';

/**
 * A selected native version of the original.
 * @param versionId - Its version.
 * @returns The source.
 */
function version(versionId: string): VideoPresentationSource {
  return { canonicalURL: ORIGINAL, sourceFingerprint: 'a'.repeat(64), manifest: null, presentation: presentedBundle(ORIGINAL, { versionId,
    playback: { kind: 'native', carrier: { storageKey: 'playback.mp4', url: 'https://cdn.test/playback.mp4', etag: '"p"', size: 1, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } }) };
}

/**
 * The layer of the clip.
 * @param presentation - Its selected version, or null.
 * @returns The layer.
 */
function layer(presentation: VideoPresentationSource | null): TimelineMediaLayer {
  return { clipId: CLIP.id, fileUrl: ORIGINAL, presentation, coverUrl: null };
}

/**
 * A controller whose elements are plain videos.
 * @returns The controller and its change spy.
 */
function controllerOf(): { controller: ReturnType<typeof createMediaLayerController>; onChange: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  return { onChange, controller: createMediaLayerController({ document: () => DOCUMENT, onChange, createMedia: () => document.createElement('video') }) };
}

beforeEach(() => { driver.made = []; vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined); });

describe('a Timeline layer playing a selected version (frames-split §7.14 Ts)', () => {
  it('VR01 plays through the renderer on the lane element, mounts its host and never loads the original', () => {
    const { controller } = controllerOf();
    controller.sync([layer(version('e'.repeat(64)))]);
    expect(driver.made).toHaveLength(1);
    expect(driver.made[0]!.video).toBe(controller.element(CLIP.id));
    expect(controller.surface(CLIP.id)).toBe(driver.made[0]!.host);
    expect(controller.surface(CLIP.id)).not.toBe(controller.element(CLIP.id));
    expect(controller.element(CLIP.id)!.getAttribute('src')).toBeNull();
  });

  it('VR02 another version is a new lane whose old renderer is released first', () => {
    const { controller } = controllerOf();
    controller.sync([layer(version('e'.repeat(64)))]);
    const first = controller.element(CLIP.id);
    controller.sync([layer(version('c'.repeat(64)))]);
    expect(driver.made).toHaveLength(2);
    expect(driver.made[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controller.element(CLIP.id)).not.toBe(first);
  });

  it('VR03 a renderer failure fails the layer; retry starts a new renderer that the old one cannot fail', () => {
    const { controller } = controllerOf();
    controller.sync([layer(version('e'.repeat(64)))]);
    driver.made[0]!.callbacks.error('media-load-failed');
    expect(controller.states().get(CLIP.id)).toBe('failed');
    expect(controller.restartRenderer(CLIP.id)).toBe(true);
    expect(driver.made).toHaveLength(2);
    expect(driver.made[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controller.states().get(CLIP.id)).toBe('ready');
    driver.made[0]!.callbacks.error('media-load-failed');
    expect(controller.states().get(CLIP.id)).toBe('ready');
  });

  it('VR04 with nothing selected the layer is its own element on the original', () => {
    const { controller } = controllerOf();
    controller.sync([layer(null)]);
    expect(driver.made).toHaveLength(0);
    expect(controller.surface(CLIP.id)).toBe(controller.element(CLIP.id));
    // The original plays in CORS mode, so the preview's audio graph can read its sound (inner#1709 design §5.2).
    expect(controller.element(CLIP.id)!.getAttribute('src')).toBe(corsUrl(ORIGINAL));
    expect(controller.restartRenderer(CLIP.id)).toBe(false);
  });
});
