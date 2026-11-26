// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 (frames-split design §7.8 fullscreen invariant): full screen opened from a canvas video node plays the same
 * selected version's playback file the node plays, not the registered original.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { VideoNode } from '@web/spaces/canvas/nodes/VideoNode';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { renderWithTooltips } from '@web/test-utils/render-with-tooltips';
import { presentedBinding, presentedBundle, presentedResponse } from '@web/test-utils/video-presentation';
import type * as RequestModule from '@web/data/api/request';
import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';

vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(() => new Promise<never>(() => undefined)),
}));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    const element = document.createElement('video');
    element.setAttribute('src', source.presentation.playback.carrier.url);
    host.append(element);
    queueMicrotask(() => callbacks.ready(element, element));
    return { dispose: () => element.remove() };
  }),
}));

const PROJECT = '60000000-0000-4000-8000-000000000013';
const ORIGINAL = 'https://assets.example.test/node/source.mov';
const PLAYBACK = 'https://assets.example.test/node/playback.mp4';
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

describe('full screen from a canvas video node (§7.8 fullscreen invariant)', () => {
  it('VF01 plays the selected playback file', async () => {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'node/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
    renderWithTooltips(<QueryClientProvider client={client}><CanvasContext.Provider value={{ projectId: PROJECT, spaceId: 'space-1', readOnly: false, myRole: 'owner', caretProvider: null }}>
      <NodeIdContext.Provider value='n1'><VideoNode data={{ handling: false, content: ORIGINAL } as React.ComponentProps<typeof VideoNode>['data']} /></NodeIdContext.Provider>
    </CanvasContext.Provider></QueryClientProvider>);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    await act(async () => { await Promise.resolve(); });
    const layer = screen.getByTestId('media-fullscreen');
    expect(layer.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(layer.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });
});
