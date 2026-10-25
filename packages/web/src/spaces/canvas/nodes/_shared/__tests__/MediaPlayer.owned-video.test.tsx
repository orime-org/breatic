// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer';
import { VideoNode } from '../../VideoNode';
import { CanvasContext } from '../../../canvas-context';
import { CanvasActionsContext } from '../../../canvas-actions';
import { NodeIdContext } from '../node-id-context';
import { QueryClientProvider, queryClient } from '@web/app/providers/QueryClientProvider';
import { videoPresentationQuery } from '../../../video-presentation/video-presentation-query';
import type { VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../../../video-presentation/types';

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

const source: VideoPresentationSource = {
  canonicalURL: 'https://assets.example.test/canonical.webm', sourceFingerprint: 'a'.repeat(64),
  presentation: { schemaVersion: 1, sourceFingerprint: 'a'.repeat(64), state: 'alpha_ready', original: { width: 160, height: 240, duration: 10 }, alpha: { manifestURL: 'https://assets.example.test/manifest.json' } },
  manifest: { schemaVersion: 1, sourceFingerprint: 'a'.repeat(64), packedURL: 'https://assets.example.test/packed.mp4', packedWidth: 320, packedHeight: 240, colorRect: { x: 0, y: 0, width: 160, height: 240 }, alphaRect: { x: 160, y: 0, width: 160, height: 240 } },
};

beforeEach(() => {
  driver.sessions = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); queryClient.clear(); });

describe('canonical owned video in the existing player', () => {
  it('keeps controls inside the canonical display box and fullscreen uses that parent, never packed dimensions', () => {
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
    const fullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(binding.container, 'requestFullscreen', { value: fullscreen });
    fireEvent.click(screen.getByTestId('fullscreen'));
    expect(fullscreen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('play-toggle'));
    expect(owned.element.play).toHaveBeenCalledOnce();
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
    const other: VideoPresentationSource = { ...source, canonicalURL: 'https://assets.example.test/other.webm', sourceFingerprint: 'b'.repeat(64), presentation: { ...source.presentation, sourceFingerprint: 'b'.repeat(64) }, manifest: { ...source.manifest!, sourceFingerprint: 'b'.repeat(64) } };
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
    const other: VideoPresentationSource = { ...source, canonicalURL: 'https://assets.example.test/replaced.webm', sourceFingerprint: 'b'.repeat(64), presentation: { ...source.presentation, sourceFingerprint: 'b'.repeat(64) }, manifest: { ...source.manifest!, sourceFingerprint: 'b'.repeat(64) } };
    view.rerender(<MediaPlayer modality='video' src={other.canonicalURL} videoSource={other} onVideoBinding={bindings} />);
    expect(driver.sessions).toHaveLength(2);
    const next = driver.sessions[1]!;
    act(() => next.callbacks.ready(next.element, next.surface));
    expect(next.element.volume).toBe(0.3);
    expect(next.element.muted).toBe(true);
    expect(next.element.paused).toBe(true);
    expect(bindings.mock.calls.at(-1)![0].binding.element).toBe(next.element);
  });

  it('keeps unknown classification blank instead of interpreting a canonical alpha URL as native', () => {
    const view = render(<MediaPlayer modality='video' src={source.canonicalURL} videoSource={null} />);
    expect(driver.sessions).toHaveLength(0);
    expect(view.container.querySelector('video')).toBeNull();
    expect(screen.getByTestId('play-toggle')).toBeDisabled();
    expect(screen.getByTestId('seek').getAttribute('data-disabled')).not.toBeNull();
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
      presentation: source.presentation, manifest: source.manifest, preparation: null, pollAfterMs: null,
    }),
  })),
}));

describe('actual VideoNode authorized presentation bridge', () => {
  it('queries its project canonical source and publishes the real binding/frame through existing canvas actions', async () => {
    const binding = vi.fn(); const frame = vi.fn();
    const data = { handling: false, content: source.canonicalURL, width: 160, height: 240, duration: 10, mimeType: 'video/webm' };
    render(<QueryClientProvider><CanvasContext.Provider value={{ projectId: 'project', spaceId: 'space', readOnly: true, myRole: 'viewer', caretProvider: null }}><CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), deleteNode: vi.fn(), activateNodeUpload: vi.fn(), beginGroupResize: vi.fn(), reportGroupResize: vi.fn(), commitGroupResize: vi.fn(), onVideoBinding: binding, onVideoFrame: frame }}><NodeIdContext.Provider value='node'><VideoNode data={data} /></NodeIdContext.Provider></CanvasActionsContext.Provider></CanvasContext.Provider></QueryClientProvider>);
    await waitFor(() => expect(videoPresentationQuery).toHaveBeenCalledWith({ projectId: 'project', canonicalURL: source.canonicalURL, active: true }));
    await waitFor(() => expect(driver.sessions).toHaveLength(1));
    const owned = driver.sessions[0]!;
    act(() => { owned.callbacks.ready(owned.element, owned.surface); owned.callbacks.frame(0.417, owned.callbacks.getSeekEpoch()); });
    expect(binding).toHaveBeenCalledWith('node', source.canonicalURL, expect.objectContaining({ status: 'ready', binding: expect.objectContaining({ element: owned.element, surface: owned.surface }) }));
    expect(frame).toHaveBeenCalledWith('node', source.canonicalURL, expect.objectContaining({ mediaTime: 0.417, surface: owned.surface }));
    expect(data.content).toBe(source.canonicalURL);
  });
});
