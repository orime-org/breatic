// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 test plan §69 U05 (frames-split design §7.8 surface list row for `TimelineSpace.tsx` and
 * `timeline-media-draft.ts`, §7.9 last paragraph): the Timeline preview reads the same presentation query Qp as the canvas
 * node. With a selected version P it plays P's playback file, not the registered original; with nothing selected and an
 * original the browser cannot play, it shows the cover and "Preparing video…" instead of a player error; a candidate failed
 * with a temporary code shows the reason and a Retry. Seeking stays in seconds.
 */

import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ProjectRegisteredAsset, TimelineVideoClip, TimelineVideoSource, VideoPresentationResponse } from '@breatic/shared';
import { initializeTimelineDocument } from '@breatic/shared/space-content';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { applyTimelineEdit } from '@web/data/yjs/timeline-document';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { TimelineSpace } from '@web/spaces/timeline/TimelineSpace';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { createVideoRenderer } from '@web/spaces/canvas/video-presentation/create-video-renderer';
import { alphaManifestQuery } from '@web/spaces/canvas/video-presentation/use-resolved-video-presentation';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

import type * as RequestModule from '@web/data/api/request';
import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';
vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, listVideos: vi.fn(), limits: vi.fn() } };
});
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(() => new Promise<never>(() => undefined)),
}));
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  // Plays through the element it is given, as the real renderer does: a native version shows that element, an alpha-packed
  // one keeps it hidden and shows the composited canvas.
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks, given?: HTMLVideoElement) => {
    const element = given ?? document.createElement('video');
    element.setAttribute('src', source.presentation.playback.carrier.url);
    const surface = source.presentation.playback.kind === 'native' ? element : document.createElement('canvas');
    if (surface instanceof HTMLCanvasElement) surface.setAttribute('data-testid', 'alpha-surface');
    host.append(surface);
    queueMicrotask(() => callbacks.ready(element, surface));
    return { dispose: () => { element.remove(); surface.remove(); } };
  }),
}));

const PROJECT = '60000000-0000-4000-8000-000000000011';
const SPACE = '70000000-0000-4000-8000-000000000011';
const SETTINGS = { width: 1920, height: 1080, fps: { num: 24, den: 1 } };
const PLAYBACK = 'https://cdn.example/timeline-playback.mp4';
const ASSET: ProjectRegisteredAsset = {
  assetId: '20000000-0000-4000-8000-000000000011', projectReferenceId: '50000000-0000-4000-8000-000000000011',
  displayName: 'Launch.mov', kind: 'video', fileUrl: 'https://cdn.example/timeline-original.mov', coverUrl: 'https://cdn.example/timeline-cover.jpg',
  width: 1280, height: 720, durationSeconds: 2, mimeType: 'video/quicktime', sizeBytes: 8192,
};
const SOURCE: TimelineVideoSource = {
  id: '10000000-0000-4000-8000-000000000011', kind: 'video', url: ASSET.fileUrl, coverUrl: ASSET.coverUrl, name: 'Launch.mov', mimeType: ASSET.mimeType,
  width: ASSET.width, height: ASSET.height, timebase: SETTINGS.fps, extentFrames: 48, durationSeconds: '2', durationOrigin: 'registered' };
const CLIP: TimelineVideoClip = {
  id: '30000000-0000-4000-8000-000000000011', kind: 'video', trackId: 'visual-1', sourceId: SOURCE.id, startFrame: 0, sourceInFrame: 0, durationFrames: 48,
  rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
};
const CONNECTED: SocketState = { provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null };
let client: QueryClient;

/**
 * Seeds the Timeline with one clip at frame 0 and Qp's read of its original, then renders the Space.
 * @param response - The read Qp answers for the clip's original URL.
 * @returns The Timeline preview area.
 */
async function mount(response: VideoPresentationResponse): Promise<HTMLElement> {
  const server = new Y.Doc();
  initializeTimelineDocument(server, SETTINGS);
  const doc = getDoc(docName.timelineSpace(PROJECT, SPACE));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'provider');
  server.destroy();
  expect(applyTimelineEdit(doc, { operation: 'add_video', parameters: { source: SOURCE, clip: CLIP }, placement: { magnet: false, linkage: false } }, 'test-setup').ok).toBe(true);
  client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ASSET.fileUrl, active: true }).queryKey, response);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={CONNECTED}>
    <TimelineSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' />
  </SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  const preview = await screen.findByTestId('timeline-preview');
  await waitFor(() => expect(preview.querySelector('video, canvas')).not.toBeNull());
  return preview;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.mocked(createVideoRenderer).mockClear();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); client.clear(); _resetForTests(); vi.restoreAllMocks(); });

describe('U05 the Timeline preview plays through Qp (§7.8, §7.9)', () => {
  it('U05: with a selected version the preview plays the playback file, not the registered original', async () => {
    const bundle = presentedBundle(ASSET.fileUrl, { playback: { kind: 'native', carrier: { storageKey: 'timeline-playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    const preview = await mount(presentedResponse(presentedBinding(ASSET.fileUrl), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    expect(preview.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(preview.querySelector(`video[src="${ASSET.fileUrl}"]`)).toBeNull();
  });

  it('U05: preparing, an original the browser cannot play shows the cover and "Preparing video…", not a player error', async () => {
    const preview = await mount(presentedResponse(presentedBinding(ASSET.fileUrl), { preparation: presentedPreparation(null) }));
    const original = preview.querySelector(`video[src="${ASSET.fileUrl}"]`);
    expect(original).not.toBeNull();
    // A browser sets the element's MediaError before it fires `error`; jsdom does not (as TimelineSpace.test does).
    Object.defineProperty(original!, 'error', { configurable: true, value: { code: 4 } });
    fireEvent.error(original!);
    expect(await screen.findByText('Preparing video…')).toBeInTheDocument();
    expect(preview.querySelector(`[src="${ASSET.coverUrl}"], [poster="${ASSET.coverUrl}"]`)).not.toBeNull();
  });

  it('U05: a candidate failed with a temporary code shows the reason and a Retry', async () => {
    const preview = await mount(presentedResponse(presentedBinding(ASSET.fileUrl), { preparation: presentedPreparation('expired') }));
    const original = preview.querySelector(`video[src="${ASSET.fileUrl}"]`);
    if (original !== null) fireEvent.error(original);
    expect(await screen.findByText('Couldn\'t prepare the video')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('U05: a selected alpha-packed version plays through the canvas renderer, its composited surface in the layer', async () => {
    const packed = { storageKey: 'timeline-packed.mp4', url: 'https://cdn.example/timeline-packed.mp4', etag: '"k"', size: 8192, sha256: '9'.repeat(64), contentType: 'video/mp4' };
    const bundle = presentedBundle(ASSET.fileUrl, { playback: { kind: 'alpha-packed', carrier: packed, manifest: { ...packed, storageKey: 'timeline-alpha.json', url: 'https://cdn.example/timeline-alpha.json', contentType: 'application/json' } } });
    const manifest = { schemaVersion: 1 as const, packed, packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 100, y: 0, width: 96, height: 64 } };
    const manifestKey = alphaManifestQuery(bundle, true).queryKey;
    client.setQueryDefaults(manifestKey, { staleTime: Infinity });
    client.setQueryData(manifestKey, manifest);
    const preview = await mount(presentedResponse(presentedBinding(ASSET.fileUrl), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    const calls = vi.mocked(createVideoRenderer).mock.calls;
    expect(calls.map(([, source]) => source.presentation.playback.kind)).toEqual(['alpha-packed']);
    expect(calls[0]![1].manifest).toEqual(manifest);
    expect(calls[0]![3]).toBeInstanceOf(HTMLVideoElement);
    expect(preview.querySelector('[data-testid="alpha-surface"]')).not.toBeNull();
    expect(preview.querySelector(`video[src="${ASSET.fileUrl}"]`)).toBeNull();
    expect(screen.queryByText(/video unavailable/)).toBeNull();
  });
});
