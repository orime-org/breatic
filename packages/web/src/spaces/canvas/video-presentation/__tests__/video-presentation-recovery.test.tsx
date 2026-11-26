// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type VideoPresentationResponse } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import { createVideoPresentationRecovery } from '../video-presentation-recovery';
import { preparationFailureKey } from '../VideoPreparationNotice';
import { videoPresentationQuery } from '../video-presentation-query';
import type { VideoPresentationSource, VideoRendererCallbacks } from '../types';
import { presentedBinding, presentedBundle, presentedPreparation, presentedDisplay, presentedResponse } from '@web/test-utils/video-presentation';

const platform = vi.hoisted(() => ({
  apiGet: vi.fn(), apiPost: vi.fn(), toastError: vi.fn(),
  sessions: [] as { element: HTMLVideoElement; surface: HTMLCanvasElement; callbacks: VideoRendererCallbacks }[],
  frames: [] as FrameRequestCallback[],
}));
vi.mock('@web/data/api/request', async (original) => ({ ...await original<Record<string, unknown>>(), apiGet: platform.apiGet, apiPost: platform.apiPost }));
vi.mock('@web/lib/toast', async (original) => ({ ...await original<Record<string, unknown>>(), toast: { error: platform.toastError } }));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (original) => ({
  ...await original<Record<string, unknown>>(),
  createVideoRenderer: (host: HTMLElement, _source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video'); const surface = document.createElement('canvas');
    surface.width = 160; surface.height = 240; host.append(surface);
    platform.sessions.push({ element, surface, callbacks });
    return { dispose: () => { element.pause(); surface.remove(); } };
  },
}));

const input = { projectId: 'project', canonicalURL: 'https://assets.example.test/canonical.webm', active: true };
// §95 (design §3.5, §7.12 step 2): nothing selected and the candidate failed is the retryable source; a repair answers the
// read response itself (fixtures migrated from the earlier state/status shapes, 4.4.5).
const sourceBinding: VideoPresentationResponse['sourceBinding'] = presentedBinding(input.canonicalURL, { width: 160, height: 240, duration: 10, mimeType: 'video/webm' });
const bundle = presentedBundle(input.canonicalURL, { display: presentedDisplay(160, 240, 250) });
const failedWith = (code: string): VideoPresentationResponse => presentedResponse(sourceBinding, { preparation: presentedPreparation(code) });
const failed = failedWith('container_failed');
const ready: VideoPresentationResponse = presentedResponse(sourceBinding, { presentation: bundle });
let client: QueryClient;

function seed(data: VideoPresentationResponse): void {
  const options = videoPresentationQuery(input);
  client.setQueryDefaults(options.queryKey, { staleTime: Infinity });
  client.setQueryData(options.queryKey, data);
  void client.fetchQuery({ ...options, staleTime: Infinity });
}

function mount(content: React.ReactNode): ReturnType<typeof render> {
  return render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId: input.projectId, spaceId: 'space', readOnly: true, myRole: 'viewer', caretProvider: null }}>{content}</CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  platform.apiGet.mockReset().mockResolvedValue(ready);
  platform.apiPost.mockReset().mockResolvedValue(ready);
  platform.toastError.mockReset(); platform.sessions = []; platform.frames = [];
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { platform.frames.push(callback); return platform.frames.length; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const gl = { createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), viewport: vi.fn(), pixelStorei: vi.fn(), createTexture: vi.fn(() => ({})), bindTexture: vi.fn(), texParameteri: vi.fn(), deleteTexture: vi.fn(), deleteBuffer: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => kind === 'webgl' ? gl as unknown as WebGLRenderingContext : null) as unknown as HTMLCanvasElement['getContext']);
  vi.stubGlobal('AudioContext', class {
    state = 'running'; destination = {};
    createGain(): GainNode { return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } } as unknown as GainNode; }
    close(): Promise<void> { return Promise.resolve(); }
  });
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('approved canonical Retry recovery (inner#1306 Canvas recovery oracle)', () => {
  it('joins an in-flight press and repairs a failed preparation from a fresh cache before refetching source facts', async () => {
    seed(failed);
    let finish!: (answer: unknown) => void;
    platform.apiPost.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const recovery = createVideoPresentationRecovery(client, input);
    const first = recovery.recover('source');
    const duplicate = recovery.recover('source');
    expect(duplicate).toBe(first);
    await waitFor(() => expect(platform.apiPost).toHaveBeenCalledOnce());
    expect(platform.apiPost).toHaveBeenCalledWith('/projects/project/assets/video-presentation/repair', {
      canonicalURL: input.canonicalURL, sourceFingerprint: sourceBinding.contentHash,
    }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }));
    expect(platform.apiGet).not.toHaveBeenCalled();
    finish(ready);
    await first;
    expect(platform.apiGet).toHaveBeenCalledOnce();
    expect(client.getQueryData(videoPresentationQuery(input).queryKey)).toEqual(ready);
  });

  // §95 (design §7.12 step 2, §3.5 web→server row; §93 D6-4): a re-presented version invalid again reports
  // presentation_invalid, a reuse whose source turned invalid reports reuse_source_invalid; both are transient, so the
  // press repairs and then rereads, like any failed candidate.
  it.each(['presentation_invalid', 'reuse_source_invalid'])('a candidate failed %s is repaired by the Retry press, then reread', async (code) => {
    seed(failedWith(code));
    const recovery = createVideoPresentationRecovery(client, input);
    await recovery.recover('source');
    expect(platform.apiPost).toHaveBeenCalledExactlyOnceWith('/projects/project/assets/video-presentation/repair', {
      canonicalURL: input.canonicalURL, sourceFingerprint: sourceBinding.contentHash,
    }, expect.objectContaining({ headers: { 'Idempotency-Key': expect.any(String) } }));
    expect(platform.apiGet).toHaveBeenCalledOnce();
    expect(client.getQueryData(videoPresentationQuery(input).queryKey)).toEqual(ready);
  });

  it('a candidate still in progress is not repaired: the press only rereads', async () => {
    seed(presentedResponse(sourceBinding, { preparation: presentedPreparation(null, 'encode') }));
    await createVideoPresentationRecovery(client, input).recover('source');
    expect(platform.apiPost).not.toHaveBeenCalled();
    expect(platform.apiGet).toHaveBeenCalledOnce();
  });

  it('rereads source facts after a repair conflict and preserves the same visibly reported error', async () => {
    seed(failed);
    const failure = new ApiException({ status: 409, message: 'The source changed.', fromServer: true });
    platform.apiPost.mockRejectedValue(failure);
    const recovery = createVideoPresentationRecovery(client, input);
    await expect(recovery.recover('source')).rejects.toBe(failure);
    expect(platform.toastError).toHaveBeenCalledExactlyOnceWith('The source changed.');
    expect(platform.apiGet).toHaveBeenCalledOnce();
    expect(client.getQueryData(videoPresentationQuery(input).queryKey)).toEqual(ready);
  });

  it('the actual node Retry repairs a failed cached preparation and attaches a fresh actual element', async () => {
    seed(failed);
    mount(<NodeIdContext.Provider value='node'><VideoNode data={{ handling: false, content: input.canonicalURL, width: 160, height: 240, duration: 10 }} /></NodeIdContext.Provider>);
    // With nothing selected the node shows the candidate's failure and, for a temporary one, its Retry (§7.9 N).
    expect(await screen.findByText(t(preparationFailureKey('container_failed')))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('canvas.task.action.retry') }));
    await waitFor(() => expect(platform.apiPost).toHaveBeenCalledOnce());
    await waitFor(() => expect(platform.sessions).toHaveLength(1));
    const session = platform.sessions[0]!;
    act(() => session.callbacks.ready(session.element, session.surface));
    expect(screen.getByTestId('play-toggle')).toBeEnabled();
    expect(platform.apiGet).toHaveBeenCalledOnce();
  });

  // §10.6 failure classes: a content failure comes out the same on every rerun, so the node shows only the candidate's
  // reason and offers no Retry (§7.9 N).
  it('the node shows a content failure without Retry', async () => {
    seed(failedWith('probe_invalid'));
    mount(<NodeIdContext.Provider value='node'><VideoNode data={{ handling: false, content: input.canonicalURL, width: 160, height: 240, duration: 10 }} /></NodeIdContext.Provider>);
    expect(await screen.findByText(t(preparationFailureKey('probe_invalid')))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('canvas.task.action.retry') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') })).toBeNull();
  });

});
