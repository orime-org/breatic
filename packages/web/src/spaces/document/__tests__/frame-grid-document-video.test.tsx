// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U05 (frames-split design §7.8 surface list, §7.9 last paragraph): a video block in a Document
 * reads the same presentation query Qp as the canvas node. With a selected version P it plays P's playback file, not the
 * original; with nothing selected it plays the original while the browser can, and when the browser cannot it shows the
 * cover and "Preparing video…" instead of a player error; a candidate failed with a temporary code shows the reason and a
 * Retry. The renderer is a driver that mounts a native element on the version's playback URL.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';
import { DocumentMediaBlock } from '@web/spaces/document/DocumentMediaBlock';
import { DocumentProjectProvider } from '@web/spaces/document/document-project-context';
import { TooltipProvider } from '@web/components/ui/tooltip';

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
    const playback = source.presentation.playback;
    element.setAttribute('src', playback.kind === 'native' ? playback.carrier.url : playback.carrier.url);
    host.append(element);
    queueMicrotask(() => callbacks.ready(element, element));
    return { dispose: () => element.remove() };
  }),
}));

const PROJECT = '60000000-0000-4000-8000-000000000009';
const ORIGINAL = 'https://assets.example.test/document/source.mov';
const PLAYBACK = 'https://assets.example.test/document/playback.mp4';
let client: QueryClient;

/**
 * Mounts a Document video block over a seeded presentation read.
 * @param response - The read Qp answers for the block's URL.
 * @returns The rendered container.
 */
function mount(response: VideoPresentationResponse): HTMLElement {
  client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, response);
  const actions = { setProps: vi.fn(), remove: vi.fn(), download: vi.fn(), dragStart: vi.fn(), dragEnd: vi.fn(), select: vi.fn(), focusBody: vi.fn(), bodyHolds: () => false };
  return render(<QueryClientProvider client={client}><TooltipProvider><DocumentProjectProvider projectId={PROJECT}>
    <DocumentMediaBlock editor={{}} blockId='video-block' readOnly={false} viewport={null} type='video' props={{ url: ORIGINAL, name: 'source.mov', caption: '', uploadId: '', mediaWidth: 1920, mediaHeight: 1080 }}
      selected={false} hovered={false} toolbarShown={false} host={document.createElement('div')} onHover={vi.fn()} actions={actions}
      commentActions={{ comment: null, read: vi.fn(), addToAgent: null }} commentCount={0} commentReading={false} tableFullscreen={false} />
  </DocumentProjectProvider></TooltipProvider></QueryClientProvider>).container;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

describe('U05 a Document video block plays through Qp (§7.8, §7.9)', () => {
  it('U05: with a selected version the block plays the playback file, not the original', async () => {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'document/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    const container = mount(presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(container.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });

  it('U05: full screen opened from the block plays the selected playback file', async () => {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'document/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    mount(presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getAllByTestId('doc-media-fullscreen')[0]!);
    await act(async () => { await Promise.resolve(); });
    const layer = screen.getByTestId('media-fullscreen');
    expect(layer.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(layer.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });

  it('U05: preparing, an original the browser cannot play shows "Preparing video…" instead of a player error', () => {
    const container = mount(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation(null) }));
    const original = container.querySelector(`video[src="${ORIGINAL}"]`);
    expect(original).not.toBeNull();
    fireEvent.error(original!);
    expect(screen.getByText('Preparing video…')).toBeInTheDocument();
  });

  it('U05: a candidate failed with a temporary code shows the reason and a Retry', () => {
    const container = mount(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation('expired') }));
    const original = container.querySelector(`video[src="${ORIGINAL}"]`);
    if (original !== null) fireEvent.error(original);
    expect(screen.getByText('Couldn\'t prepare the video')).toBeInTheDocument();
    // The block itself is a button whose name includes its text, so the Retry button is matched by its whole name.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
