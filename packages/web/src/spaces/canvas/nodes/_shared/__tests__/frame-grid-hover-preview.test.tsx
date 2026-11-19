// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U05 (frames-split design §7.8 surface list row for `HoverPreview.tsx` and its callers, the node
 * history and the project activity panel; §7.9 last paragraph): a video hover preview reads the same presentation query
 * Qp as the canvas node. With a selected version P it plays P's playback file; with nothing selected and an original the
 * browser cannot play, it shows the cover and "Preparing video…"; a failed candidate shows only the reason, no Retry.
 * How the preview learns its Project is not fixed by the design; this file passes it as a `projectId` prop.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPresentationResponse } from '@breatic/shared';
import { HoverPreview, type HoverPreviewProps } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { presentedBinding, presentedBundle, presentedPreparation, presentedResponse } from '@web/test-utils/video-presentation';

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

const Preview = HoverPreview as unknown as React.ComponentType<HoverPreviewProps & { projectId: string }>;
const PROJECT = '60000000-0000-4000-8000-000000000012';
const ORIGINAL = 'https://assets.example.test/hover/source.mov';
const PLAYBACK = 'https://assets.example.test/hover/playback.mp4';
const COVER = 'https://assets.example.test/hover/cover.jpg';
let client: QueryClient;

/**
 * Renders a video hover preview over a seeded presentation read and opens it.
 * @param response - The read Qp answers for the original URL.
 * @returns The opened card's content.
 */
function open(response: VideoPresentationResponse): HTMLElement {
  client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, response);
  render(<QueryClientProvider client={client}><Preview kind='video' src={ORIGINAL} poster={COVER} projectId={PROJECT}><span data-testid='trigger'>row</span></Preview></QueryClientProvider>);
  fireEvent.pointerEnter(screen.getByTestId('trigger'), { pointerType: 'mouse' });
  act(() => { vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10); });
  return screen.getByTestId('hover-preview-content');
}

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('U05 a video hover preview plays through Qp (§7.8, §7.9)', () => {
  it('U05: with a selected version the preview plays the playback file, not the original', async () => {
    const bundle = presentedBundle(ORIGINAL, { playback: { kind: 'native', carrier: { storageKey: 'hover/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' }, displayRect: null } });
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { presentation: bundle }));
    await act(async () => { await Promise.resolve(); });
    expect(card.querySelector(`video[src="${PLAYBACK}"]`)).not.toBeNull();
    expect(card.querySelector(`video[src="${ORIGINAL}"]`)).toBeNull();
  });

  it('U05: preparing, an original the browser cannot play shows the cover and "Preparing video…"', () => {
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation(null) }));
    const original = card.querySelector(`video[src="${ORIGINAL}"]`);
    expect(original).not.toBeNull();
    fireEvent.error(original!);
    expect(screen.getByText('Preparing video…')).toBeInTheDocument();
    expect(card.querySelector(`[src="${COVER}"], [poster="${COVER}"]`)).not.toBeNull();
  });

  it('U05: a failed candidate shows only the reason, with no Retry in a hover preview', () => {
    const card = open(presentedResponse(presentedBinding(ORIGINAL), { preparation: presentedPreparation('expired') }));
    const original = card.querySelector(`video[src="${ORIGINAL}"]`);
    if (original !== null) fireEvent.error(original);
    expect(screen.getByText('Couldn\'t prepare the video')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
