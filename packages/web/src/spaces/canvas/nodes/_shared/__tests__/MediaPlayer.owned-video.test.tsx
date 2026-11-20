// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer';
import { VideoNode } from '../../VideoNode';
import { CanvasContext } from '../../../canvas-context';
import { CanvasActionsContext } from '../../../canvas-actions';
import { NodeIdContext } from '../node-id-context';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { QueryClientProvider, queryClient } from '@web/app/providers/QueryClientProvider';
import { videoPresentationQuery } from '../../../video-presentation/video-presentation-query';
import type { VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../../../video-presentation/types';
import { PRESENTED, presentedBundle, presentedDisplay } from '@web/test-utils/video-presentation';

const driver = vi.hoisted(() => ({ sessions: [] as { element: HTMLVideoElement; surface: HTMLCanvasElement; callbacks: VideoRendererCallbacks; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../video-presentation/create-video-renderer')>()),
  createVideoRenderer: vi.fn((host: HTMLElement, _source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    const surface = document.createElement('canvas'); surface.width = 160; surface.height = 240;
    Object.defineProperties(element, { videoWidth: { value: 320 }, videoHeight: { value: 240 } });
    host.append(surface);
    const dispose = vi.fn(() => { element.pause(); surface.remove(); });
    driver.sessions.push({ element, surface, callbacks, dispose });
    return { dispose };
  }),
}));

// §97 (D10-1, D10-2; design §3.3, §3.5, §7.8): an alpha-packed source carries its selected bundle and the manifest naming
// the packed carrier (fixtures migrated from `state`/`packedURL`, 4.4.5).
const packed = { storageKey: 'packed.mp4', url: 'https://assets.example.test/packed.mp4', etag: '"packed"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
/**
 * An alpha-packed source of one version.
 * @param canonicalURL - The source URL.
 * @param fingerprint - Its content hash.
 * @param versionId - The selected version.
 * @returns The source.
 */
function alphaSource(canonicalURL: string, fingerprint: string, versionId: string): VideoPresentationSource {
  return { canonicalURL, sourceFingerprint: fingerprint, presentation: presentedBundle(canonicalURL, { sourceFingerprint: fingerprint, versionId,
    display: presentedDisplay(160, 240, 250),
    playback: { kind: 'alpha-packed', carrier: packed, manifest: { ...packed, storageKey: 'manifest.json', url: 'https://assets.example.test/manifest.json', contentType: 'application/json' } } }),
  manifest: { schemaVersion: 1, packed,
    packedWidth: 320, packedHeight: 240, colorRect: { x: 0, y: 0, width: 160, height: 240 }, alphaRect: { x: 160, y: 0, width: 160, height: 240 } } };
}
const source = alphaSource('https://assets.example.test/canonical.webm', PRESENTED.fingerprint, PRESENTED.versionId);

beforeEach(() => {
  driver.sessions = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); queryClient.clear(); });

describe('canonical owned video in the existing player', () => {
  // Full screen left the player for the corner button (`MediaFullscreen`), which opens its own view of the source.
  it('keeps controls inside the canonical display box, never packed dimensions', () => {
    const onDimensions = vi.fn(); const onBinding = vi.fn();
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} onVideoBinding={onBinding} onDimensions={onDimensions} />);
    expect(driver.sessions).toHaveLength(1);
    const owned = driver.sessions[0]!;
    act(() => owned.callbacks.ready(owned.element, owned.surface));
    const binding = onBinding.mock.calls.at(-1)![0].binding;
    expect(binding.element).toBe(owned.element);
    expect(binding.container.contains(screen.getByTestId('controls'))).toBe(true);
    expect(binding.container.style.aspectRatio).toBe('160/240');
    expect(onDimensions).toHaveBeenCalledWith({ width: 160, height: 240 });
    expect(view.container.querySelector(`video[src="${source.canonicalURL}"]`)).toBeNull();
    fireEvent.click(screen.getByTestId('play-toggle'));
    expect(owned.element.play).toHaveBeenCalledOnce();
  });

  // The erase status label on the overlay host keys its offset to this attribute so it sits above the shown control bar.
  it('tells the overlay host whether the control bar is shown over the video', () => {
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} />);
    expect(screen.getByTestId('video-tool-overlay-host')).toHaveAttribute('data-controls', 'shown');
    view.rerender(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} controlsHidden />);
    expect(screen.getByTestId('video-tool-overlay-host')).toHaveAttribute('data-controls', 'hidden');
  });

  it('forwards the actual paused first-frame clock synchronously and invalidates it before seek or replacement', () => {
    const frames = vi.fn(); const bindings = vi.fn();
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} onVideoBinding={bindings} onPresentedFrame={frames} />);
    expect(driver.sessions).toHaveLength(1);
    const first = driver.sessions[0]!;
    first.element.currentTime = 7;
    act(() => { first.callbacks.ready(first.element, first.surface); first.callbacks.frame(0.417, first.callbacks.getSeekEpoch()); expect(frames).toHaveBeenCalledOnce(); });
    expect(frames.mock.calls[0]![0]).toMatchObject({ mediaTime: 0.417, surface: first.surface });
    const binding = bindings.mock.calls.at(-1)![0].binding;
    expect(binding.getPresentedFrame().mediaTime).toBe(0.417);
    act(() => binding.seek(2));
    expect(binding.getPresentedFrame()).toBeNull();
    const other = alphaSource('https://assets.example.test/other.webm', 'b'.repeat(64), 'c'.repeat(64));
    view.rerender(<MediaPlayer modality='video' src={other.canonicalURL} videoSource={other} onVideoBinding={bindings} onPresentedFrame={frames} />);
    expect(first.dispose).toHaveBeenCalledOnce();
    act(() => first.callbacks.frame(9, 0));
    expect(frames).toHaveBeenCalledOnce();
    expect(bindings.mock.calls.at(-1)![0].binding).toBeNull();
  });

  it('preserves the node volume and mute when the presentation owner replaces its actual element', () => {
    const bindings = vi.fn();
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} onVideoBinding={bindings} />);
    expect(driver.sessions).toHaveLength(1);
    const first = driver.sessions[0]!;
    act(() => first.callbacks.ready(first.element, first.surface));
    act(() => { first.element.volume = 0.3; first.element.muted = true; first.element.dispatchEvent(new Event('volumechange')); });
    const other = alphaSource('https://assets.example.test/replaced.webm', 'b'.repeat(64), 'c'.repeat(64));
    view.rerender(<MediaPlayer modality='video' src={other.canonicalURL} videoSource={other} onVideoBinding={bindings} />);
    expect(driver.sessions).toHaveLength(2);
    const next = driver.sessions[1]!;
    act(() => next.callbacks.ready(next.element, next.surface));
    expect(next.element.volume).toBe(0.3);
    expect(next.element.muted).toBe(true);
    expect(next.element.paused).toBe(true);
    expect(bindings.mock.calls.at(-1)![0].binding.element).toBe(next.element);
  });

  // With nothing selected the original plays for display only (frames-split §7.8 detached × Attach): no renderer is made.
  it('plays the original for display while no version is selected, without a presentation renderer', () => {
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={null} />);
    expect(driver.sessions).toHaveLength(0);
    expect(view.container.querySelector(`video[src="${source.canonicalURL}"]`)).not.toBeNull();
  });

  it('releases StrictMode resources and inactive displays without accepting disposed frames', () => {
    const frames = vi.fn();
    const view = render(<React.StrictMode><MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} active onPresentedFrame={frames} /></React.StrictMode>);
    expect(driver.sessions).toHaveLength(2);
    expect(driver.sessions[0]!.dispose).toHaveBeenCalledOnce();
    const current = driver.sessions[1]!;
    act(() => current.callbacks.ready(current.element, current.surface));
    view.rerender(<React.StrictMode><MediaPlayer modality='video' src={source.canonicalURL} videoSource={source} active={false} onPresentedFrame={frames} /></React.StrictMode>);
    expect(current.dispose).toHaveBeenCalledOnce();
    act(() => current.callbacks.frame(1, 0));
    expect(frames).not.toHaveBeenCalled();
  });
});


vi.mock('@web/spaces/canvas/video-presentation/video-presentation-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../video-presentation/video-presentation-query')>()),
  videoPresentationQuery: vi.fn((input: { projectId: string; canonicalURL: string; active: boolean }) => ({
    queryKey: ['video-presentation', 1, input.projectId, input.canonicalURL], enabled: input.active,
    queryFn: async (): Promise<VideoPresentationResponse> => ({
      sourceBinding: { assetId: '10000000-0000-4000-8000-000000000001', contentHash: source.sourceFingerprint, canonicalURL: input.canonicalURL, kind: 'video', mediaInfo: { width: 160, height: 240, duration: 10, mimeType: 'video/webm' } },
      // The read carries the selected bundle; the manifest is a bundle receipt, not a response field.
      presentation: presentedBundle(input.canonicalURL, { sourceFingerprint: source.sourceFingerprint, display: presentedDisplay(160, 240, 250) }),
      preparation: null, pollAfterMs: null,
    }),
  })),
}));

describe('actual VideoNode authorized presentation bridge', () => {
  it('queries its project canonical source and publishes the real binding/frame through existing canvas actions', async () => {
    const binding = vi.fn(); const frame = vi.fn();
    const data = { handling: false, content: source.canonicalURL, width: 160, height: 240, duration: 10, mimeType: 'video/webm' };
    render(<QueryClientProvider><TooltipProvider><CanvasContext.Provider value={{ projectId: 'project', spaceId: 'space', readOnly: true, myRole: 'viewer', caretProvider: null }}><CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), deleteNode: vi.fn(), activateNodeUpload: vi.fn(), beginGroupResize: vi.fn(), reportGroupResize: vi.fn(), commitGroupResize: vi.fn(), onVideoBinding: binding, onVideoFrame: frame }}><NodeIdContext.Provider value='node'><VideoNode data={data} /></NodeIdContext.Provider></CanvasActionsContext.Provider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(videoPresentationQuery).toHaveBeenCalledWith({ projectId: 'project', canonicalURL: source.canonicalURL, active: true }));
    await waitFor(() => expect(driver.sessions).toHaveLength(1));
    const owned = driver.sessions[0]!;
    act(() => { owned.callbacks.ready(owned.element, owned.surface); owned.callbacks.frame(0.417, owned.callbacks.getSeekEpoch()); });
    expect(binding).toHaveBeenCalledWith('node', source.canonicalURL, expect.objectContaining({ status: 'ready', binding: expect.objectContaining({ element: owned.element, surface: owned.surface }) }));
    expect(frame).toHaveBeenCalledWith('node', source.canonicalURL, expect.objectContaining({ mediaTime: 0.417, surface: owned.surface }));
    expect(data.content).toBe(source.canonicalURL);
  });
});
