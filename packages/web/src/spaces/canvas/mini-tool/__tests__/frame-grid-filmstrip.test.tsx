// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * frames-split design §7.8 surface list rows 2 and 5: the split tool's filmstrip and the older tools' range bar decode the
 * selected version's playback file, through the renderer playback uses (native and alpha-packed alike), never a bare
 * element on the registered original. The batch-6 strip spans the version's grid length (display.duration); the older
 * range bar keeps its seconds axis.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoToolDraftById } from '@breatic/shared/mini-tools';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { FilmStrip, PresentedFilmStrip } from '@web/spaces/canvas/mini-tool/FilmStrip';
import { VideoToolControls } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import type { VideoPresentationSource, VideoRendererCallbacks } from '@web/spaces/canvas/video-presentation/types';
import { videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { presentedBinding, presentedBundle, presentedDisplay, presentedResponse } from '@web/test-utils/video-presentation';
import type * as RequestModule from '@web/data/api/request';
import type * as RendererModule from '@web/spaces/canvas/video-presentation/create-video-renderer';

const driver = vi.hoisted(() => ({ sources: [] as VideoPresentationSource[], surfaces: [] as HTMLCanvasElement[] }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(() => new Promise<never>(() => undefined)),
}));
// A renderer that reports ready with a canvas surface and presents each sought grid frame, as the alpha renderer does.
vi.mock('@web/spaces/canvas/video-presentation/create-video-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof RendererModule>()),
  createVideoRenderer: vi.fn((host: HTMLElement, source: VideoPresentationSource, callbacks: VideoRendererCallbacks) => {
    driver.sources.push(source);
    const element = document.createElement('video');
    element.setAttribute('src', source.presentation.playback.carrier.url);
    const surface = document.createElement('canvas');
    surface.width = source.presentation.display.width; surface.height = source.presentation.display.height;
    driver.surfaces.push(surface);
    const fps = source.presentation.display.fps;
    let time = 0;
    Object.defineProperty(element, 'currentTime', { configurable: true, get: () => time, set: (value: number) => {
      time = value;
      queueMicrotask(() => callbacks.frame(Math.floor(value * fps.numerator / fps.denominator) * fps.denominator / fps.numerator, callbacks.getSeekEpoch()));
    } });
    host.append(element);
    queueMicrotask(() => callbacks.ready(element, surface));
    return { dispose: () => element.remove() };
  }),
}));

const PROJECT = '60000000-0000-4000-8000-000000000014';
const ORIGINAL = 'https://assets.example.test/strip/source.mov';
const PLAYBACK = 'https://assets.example.test/strip/playback.mp4';
const display = presentedDisplay(96, 64, 125);
const carrier = { storageKey: 'strip/playback.mp4', url: PLAYBACK, etag: '"p"', size: 4096, sha256: 'b'.repeat(64), contentType: 'video/mp4' };
const native: VideoPresentationSource = { canonicalURL: ORIGINAL, sourceFingerprint: 'a'.repeat(64), manifest: null,
  presentation: presentedBundle(ORIGINAL, { display, playback: { kind: 'native', carrier, displayRect: null } }) };
const packed = { ...carrier, storageKey: 'strip/packed.mp4', url: 'https://assets.example.test/strip/packed.mp4' };
const alpha: VideoPresentationSource = { canonicalURL: ORIGINAL, sourceFingerprint: 'a'.repeat(64),
  presentation: presentedBundle(ORIGINAL, { display, playback: { kind: 'alpha-packed', carrier: packed, manifest: { ...packed, storageKey: 'strip/alpha.json', url: 'https://assets.example.test/strip/alpha.json', contentType: 'application/json' } } }),
  manifest: { schemaVersion: 1, packed, packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 100, y: 0, width: 96, height: 64 } } };
let assigned: string[];
let drawn: CanvasImageSource[];
let client: QueryClient;

beforeEach(() => {
  driver.sources = []; driver.surfaces = []; assigned = []; drawn = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(192);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(32);
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!;
  vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLMediaElement, value: string): void { assigned.push(value); src.set!.call(this, value); });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({ drawImage: (image: CanvasImageSource) => { drawn.push(image); }, clearRect: () => undefined }) as unknown as ReturnType<HTMLCanvasElement['getContext']>);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

/**
 * Lets the renderer report ready and present every sought frame.
 * @throws {never} Never.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await act(async () => { await Promise.resolve(); });
}

describe('the filmstrip decodes the selected version (frames-split §7.8 surface list)', () => {
  it('FS01 a native version is decoded from its playback file through the renderer, never the original', async () => {
    render(<FilmStrip src={ORIGINAL} source={native} duration={5} aspect={96 / 64} />);
    await settle();
    expect(driver.sources).toEqual([native]);
    expect(assigned).not.toContain(ORIGINAL);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((image) => image === driver.surfaces[0])).toBe(true);
  });

  it('FS02 an alpha-packed version draws its tiles from the renderer surface, not the packed video', async () => {
    render(<FilmStrip src={ORIGINAL} source={alpha} duration={5} aspect={96 / 64} />);
    await settle();
    expect(driver.sources).toEqual([alpha]);
    expect(assigned).not.toContain(ORIGINAL);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((image) => image instanceof HTMLCanvasElement)).toBe(true);
  });

  it('FS03 the split strip decodes the selected version on its grid length', async () => {
    const source = { nodeId: '10000000-0000-4000-8000-000000000001', canonicalURL: ORIGINAL, mediaInfo: { width: 96, height: 64, duration: 7, mimeType: 'video/quicktime' } };
    const draft: VideoToolDraftById['video.split'] = { version: 1, draftId: '20000000-0000-4000-8000-000000000001', revision: '30000000-0000-4000-8000-000000000001', source, inputs: [], params: { cuts: [25] } };
    const view = render(<VideoToolControls toolId='video.split' draft={draft} onChange={vi.fn()} analyses={[]} grid={{ fps: display.fps, frameCount: display.frameCount }} previewSource={alpha}
      presentedTime={1} disabled={false} onAnalyse={vi.fn()} analysing={false} onSeek={vi.fn()} />);
    await settle();
    expect(driver.sources).toEqual([alpha]);
    expect(assigned).not.toContain(ORIGINAL);
    expect(view.getByTestId('video-playback-times')).toHaveTextContent('5.00 s');
  });

  it('FS04 the older range bar reads the selected version through the presentation query', async () => {
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, presentedResponse(presentedBinding(ORIGINAL), { presentation: native.presentation }));
    render(<QueryClientProvider client={client}><CanvasContext.Provider value={{ projectId: PROJECT, spaceId: 'space-1', readOnly: false, myRole: 'owner', caretProvider: null }}>
      <PresentedFilmStrip src={ORIGINAL} duration={5} aspect={96 / 64} />
    </CanvasContext.Provider></QueryClientProvider>);
    await settle();
    expect(driver.sources.map((value) => value.presentation.versionId)).toEqual([native.presentation.versionId]);
    expect(assigned).not.toContain(ORIGINAL);
  });

  it('FS05 with nothing selected the range bar decodes the original for display', async () => {
    client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: ORIGINAL, active: true }).queryKey, presentedResponse(presentedBinding(ORIGINAL)));
    render(<QueryClientProvider client={client}><CanvasContext.Provider value={{ projectId: PROJECT, spaceId: 'space-1', readOnly: false, myRole: 'owner', caretProvider: null }}>
      <PresentedFilmStrip src={ORIGINAL} duration={5} aspect={96 / 64} />
    </CanvasContext.Provider></QueryClientProvider>);
    await settle();
    expect(driver.sources).toEqual([]);
    expect(assigned).toContain(ORIGINAL);
  });
});
