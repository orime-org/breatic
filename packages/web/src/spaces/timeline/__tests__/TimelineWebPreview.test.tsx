// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A web copy that is not ready draws no picture (inner#1711 design §8). `<hyperframes-player>` paints its own black
 * box, so a player whose page has not yet answered a position since it (re)loaded is mounted, so its page loads, but
 * kept invisible: the Timeline preview notes that copy as loading by track, and the execution list's result preview
 * shows a skeleton in its frame.
 *
 * The Timeline preview takes each instance's state from the playback, so its cases pass the states the host would
 * report. The result preview owns its host, so its cases answer the bridge from the player's iframe window the way
 * the page does (`breatic-bridge-ready`, then `breatic-frame-ready` for the last seek); the player is an inert
 * element whose iframe window records what the host posts.
 */

import * as React from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@breatic/shared';

import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { TimelineWebPreview, type TimelineWebEntry } from '@web/spaces/timeline/TimelineWebPreview';
import { TimelineWebResultPreview } from '@web/spaces/timeline/TimelineWebResultPreview';
import type { WebInstanceState } from '@web/spaces/timeline/web-animation-host';
import { SRC_A, boundTo, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, previewUrl: vi.fn(), limits: vi.fn() } };
});
// The player module as the preview loads it: a case sets `fail` to make the next import reject, as a chunk that a
// release removed or a dropped connection does.
const playerModule = vi.hoisted(() => ({ fail: false, imports: 0 }));
vi.mock('@hyperframes/player', () => {
  playerModule.imports += 1;
  if (playerModule.fail) throw new Error('Failed to fetch dynamically imported module');
  return {};
});
// The marker proves the frame shows the shared Skeleton, not a copy of its classes.
vi.mock('@web/components/ui/skeleton', () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} data-ui-skeleton='' />,
}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const EXECUTION = '90000000-0000-4000-8000-000000000002';
const COPY = '30000000-0000-4000-8000-000000000101';
const KEY = `${SRC_A}:0`;
const TRACK = 'Visual 2';
const FPS = { num: 24, den: 1 };
const PREVIEW_URL = 'https://preview.example/web-animation/token/index.html';
const LOADING_NOTE = `${TRACK}: web animation loading…`;
const ENTRY: TimelineWebEntry = {
  clip: webClip(COPY, 'v2', 0, 48, boundTo(SRC_A)), track: TRACK, z: 2, instance: { key: KEY, sourceVersionId: SRC_A, fps: FPS }, status: null,
};
const ENTRIES = [ENTRY];

const LIMITS = {
  defaults: { width: 1920, height: 1080, fps: FPS },
  assets: { pageSize: 50, pageMax: 100 },
  webAnimation: { promptMaxLength: 4000, durationSeconds: { min: 1, max: 60, default: 4 }, aspects: ['16:9', '9:16', '1:1'], playerLoadTimeoutMs: 50, sourceRefreshIntervalMs: 10000 },
};

beforeEach(() => {
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: PREVIEW_URL });
  vi.mocked(timelineApi.limits).mockReset().mockResolvedValue(LIMITS as never);
  playerModule.fail = false;
  playerModule.imports = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // jsdom iframes cannot be sandboxed; a case that pretends they can must not leak that into the shared document.
  Reflect.deleteProperty(HTMLIFrameElement.prototype, 'sandbox');
});

/**
 * Let iframes count as sandboxable, as in every browser the product supports, so the preview loads the player module.
 * @throws {never} Never.
 */
function sandboxableIframes(): void {
  Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', { configurable: true, get: () => document.createElement('div').classList });
}

/**
 * Render the Timeline preview's web layers with one copy in this state.
 * @param state - The instance's state as the playback reports it; none before the playback attached it.
 * @returns A rerender taking the next state.
 * @throws {Error} When rendering fails.
 */
function showPreview(state: WebInstanceState | undefined): (next: WebInstanceState | undefined) => void {
  const onPlayer = vi.fn();
  const onRetry = vi.fn();
  const states = (value: WebInstanceState | undefined): ReadonlyMap<string, WebInstanceState> => new Map(value === undefined ? [] : [[KEY, value]]);
  const view = (value: WebInstanceState | undefined): React.JSX.Element => <div className='relative' data-testid='preview'>
    <TimelineWebPreview projectId={PROJECT} entries={ENTRIES} states={states(value)} onPlayer={onPlayer} onRetry={onRetry} />
  </div>;
  const { rerender } = render(view(state));
  return (next) => { rerender(view(next)); };
}

/**
 * The copy's player, once its address is in.
 * @returns It.
 * @throws {Error} When it never mounts.
 */
async function player(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByTestId('preview').querySelector('hyperframes-player')).not.toBeNull());
  return screen.getByTestId('preview').querySelector('hyperframes-player') as HTMLElement;
}

describe('Timeline preview of a web copy', () => {
  it.each([undefined, 'loading', 'waiting'] as const)('mounts the player of a copy whose page has not answered (%s) but draws nothing and notes it is loading', async (state) => {
    showPreview(state);
    const element = await player();
    expect(element).toHaveAttribute('src', PREVIEW_URL);
    expect(element).toHaveAttribute('data-web-state', state ?? 'loading');
    expect(element.style.opacity).toBe('0');
    expect(await screen.findByTestId(`timeline-web-note-${COPY}`)).toHaveTextContent(LOADING_NOTE);
  });

  it('draws a copy once its page has answered and keeps that picture, without a note, while a seek waits', async () => {
    const next = showPreview('loading');
    const element = await player();
    next('ready');
    expect(element).toHaveAttribute('data-web-state', 'ready');
    expect(element.style.opacity).not.toBe('0');
    expect(screen.queryByTestId(`timeline-web-note-${COPY}`)).toBeNull();
    next('waiting');
    expect(await player()).toBe(element);
    expect(element).toHaveAttribute('data-web-state', 'waiting');
    expect(element.style.opacity).not.toBe('0');
    expect(screen.queryByTestId(`timeline-web-note-${COPY}`)).toBeNull();
  });

  it('hides a reloaded copy and notes it loading again until its page answers', async () => {
    const next = showPreview('ready');
    const element = await player();
    expect(element.style.opacity).not.toBe('0');
    next('loading');
    expect(element).toHaveAttribute('data-web-state', 'loading');
    expect(element.style.opacity).toBe('0');
    expect(await screen.findByTestId(`timeline-web-note-${COPY}`)).toHaveTextContent(LOADING_NOTE);
    next('waiting');
    expect(element.style.opacity).toBe('0');
    expect(screen.getByTestId(`timeline-web-note-${COPY}`)).toHaveTextContent(LOADING_NOTE);
    next('ready');
    expect(element).toHaveAttribute('data-web-state', 'ready');
    expect(element.style.opacity).not.toBe('0');
    expect(screen.queryByTestId(`timeline-web-note-${COPY}`)).toBeNull();
  });

  it('keeps the unavailable note with its retry, not the loading note, for a failed copy', async () => {
    showPreview('failed');
    const element = await player();
    expect(element).toHaveAttribute('data-web-state', 'failed');
    const note = await screen.findByTestId(`timeline-web-note-${COPY}`);
    await waitFor(() => expect(note).toHaveTextContent(`${TRACK}: web animation unavailable`));
    expect(note).not.toHaveTextContent(LOADING_NOTE);
    expect(within(note).getByTestId(`timeline-web-retry-${COPY}`)).toBeInTheDocument();
  });

  it('keeps the same player and page address when its Space tab is hidden while loading and shown again', async () => {
    vi.mocked(timelineApi.previewUrl).mockReset()
      .mockResolvedValueOnce({ url: PREVIEW_URL })
      .mockResolvedValue({ url: 'https://preview.example/web-animation/other-token/index.html' });
    const onPlayer = vi.fn();
    const view = (mode: 'visible' | 'hidden'): React.JSX.Element => <React.Activity mode={mode}><div className='relative' data-testid='preview'>
      <TimelineWebPreview projectId={PROJECT} entries={ENTRIES} states={new Map([[KEY, 'loading']])} onPlayer={onPlayer} onRetry={vi.fn()} />
    </div></React.Activity>;
    const { rerender } = render(view('visible'));
    const element = await player();
    rerender(view('hidden'));
    rerender(view('visible'));
    await act(async () => { await Promise.resolve(); });
    // A new address would reload the page that was already loading.
    expect(await player()).toBe(element);
    expect(element).toHaveAttribute('src', PREVIEW_URL);
    expect(timelineApi.previewUrl).toHaveBeenCalledTimes(1);
  });

  it('notes a copy unavailable with a retry when the player module fails to load, and loads it again on retry', async () => {
    sandboxableIframes();
    playerModule.fail = true;
    const onPlayer = vi.fn();
    render(<div className='relative' data-testid='preview'>
      <TimelineWebPreview projectId={PROJECT} entries={ENTRIES} states={new Map()} onPlayer={onPlayer} onRetry={vi.fn()} />
    </div>);
    await waitFor(() => expect(playerModule.imports).toBe(1));
    const note = await screen.findByTestId(`timeline-web-note-${COPY}`);
    await waitFor(() => expect(note).toHaveTextContent(`${TRACK}: web animation unavailable`));
    expect(note).not.toHaveTextContent(LOADING_NOTE);
    expect(onPlayer).not.toHaveBeenCalled();

    playerModule.fail = false;
    await userEvent.click(within(note).getByTestId(`timeline-web-retry-${COPY}`));
    await waitFor(() => expect(playerModule.imports).toBe(2));
    // Once the module is in, the player is handed to the playback and the copy waits for its page like any other.
    const element = await player();
    await waitFor(() => expect(onPlayer).toHaveBeenCalledWith(KEY, element));
    expect(screen.getByTestId(`timeline-web-note-${COPY}`)).toHaveTextContent(LOADING_NOTE);
  });
});

/** The result preview's player with an iframe window that records what the host posts. */
interface ResultPlayer { element: HTMLElement; frameWindow: Window; posted: ReturnType<typeof vi.fn> }

/**
 * Give a mounted player the iframe the real element exposes, with a window that records what the host posts.
 * @param element - The mounted player.
 * @returns The player and its window.
 * @throws {never} Never.
 */
function withIframe(element: HTMLElement): ResultPlayer {
  const iframe = document.createElement('iframe');
  const posted = vi.fn();
  const frameWindow = { postMessage: posted } as unknown as Window;
  Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => frameWindow });
  Object.defineProperty(element, 'iframeElement', { configurable: true, get: () => iframe });
  return { element, frameWindow, posted };
}

/**
 * Deliver a message to the window as if `source` posted it.
 * @param data - The message.
 * @param source - The posting window.
 * @throws {never} Never.
 */
function reply(data: unknown, source: Window): void {
  // jsdom's MessageEvent accepts only a real window as its source.
  const event = new Event('message');
  Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: 'null' } });
  act(() => { window.dispatchEvent(event); });
}

/**
 * The page answers the last seek the host sent it.
 * @param result - The player.
 * @throws {Error} When no seek was posted.
 */
function answerLastSeek(result: ResultPlayer): void {
  const seek = result.posted.mock.calls.map((call) => call[0] as { type?: string; session?: unknown; sequence?: unknown })
    .filter((message) => message.type === 'breatic-seek').at(-1);
  if (seek === undefined) throw new Error('no seek was posted');
  reply({ type: 'breatic-frame-ready', session: seek.session, sequence: seek.sequence }, result.frameWindow);
}

describe('execution list result preview', () => {
  beforeEach(() => {
    // The player counts as defined, so the preview drives it; the element itself stays inert.
    const get = customElements.get.bind(customElements);
    vi.spyOn(customElements, 'get').mockImplementation((name) => (name === 'hyperframes-player' ? HTMLElement : get(name)));
  });

  it('shows a skeleton instead of the player until its page answers, then draws the player', async () => {
    showResult();
    await waitFor(() => expect(document.querySelector('hyperframes-player')).not.toBeNull());
    const result = withIframe(document.querySelector('hyperframes-player') as HTMLElement);
    const frame = result.element.parentElement as HTMLElement;
    expect(result.element).toHaveAttribute('data-web-state', 'loading');
    expect(result.element.style.opacity).toBe('0');
    expect(frame.querySelector('[data-ui-skeleton]')).not.toBeNull();

    reply({ type: 'breatic-bridge-ready' }, result.frameWindow);
    expect(result.element).toHaveAttribute('data-web-state', 'waiting');
    expect(result.element.style.opacity).toBe('0');
    expect(frame.querySelector('[data-ui-skeleton]')).not.toBeNull();

    answerLastSeek(result);
    expect(result.element).toHaveAttribute('data-web-state', 'ready');
    expect(result.element.style.opacity).not.toBe('0');
    expect(frame.querySelector('[data-ui-skeleton]')).toBeNull();
  });

  it('shows unavailable with a retry instead of the skeleton when its preview address is refused, and fetches a new one on retry', async () => {
    vi.mocked(timelineApi.previewUrl).mockRejectedValueOnce(new Error('refused'));
    showResult();
    const retry = await screen.findByRole('button', { name: t('timeline.retry') });
    expect(document.querySelector('[data-ui-skeleton]')).toBeNull();
    expect(document.querySelector('hyperframes-player')).toBeNull();
    await userEvent.click(retry);
    await waitFor(() => expect(timelineApi.previewUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('hyperframes-player')).toHaveAttribute('src', PREVIEW_URL));
    expect(screen.queryByRole('button', { name: t('timeline.retry') })).toBeNull();
  });

  it('fails a page that never says it is ready within the Timeline player load timeout and offers a retry', async () => {
    showResult();
    await waitFor(() => expect(document.querySelector('hyperframes-player')).not.toBeNull());
    withIframe(document.querySelector('hyperframes-player') as HTMLElement);
    // No bridge-ready ever comes; the Timeline limits give 50 ms.
    const retry = await screen.findByRole('button', { name: t('timeline.retry') });
    expect(document.querySelector('[data-ui-skeleton]')).toBeNull();
    const calls = vi.mocked(timelineApi.previewUrl).mock.calls.length;
    await userEvent.click(retry);
    await waitFor(() => expect(vi.mocked(timelineApi.previewUrl).mock.calls.length).toBeGreaterThan(calls));
  });
});

/**
 * Render a succeeded execution's result preview inside the query cache the execution list provides.
 * @throws {Error} When rendering fails.
 */
function showResult(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  // The list opens inside the Timeline Space, which has read the Timeline limits already.
  client.setQueryData(['timeline-limits', PROJECT], LIMITS);
  render(<QueryClientProvider client={client}>
    <TimelineWebResultPreview projectId={PROJECT} executionId={EXECUTION} sourceVersionId={SRC_A}
      input={{ prompt: 'Gold dot along an arc', engine: 'deepseek', aspect: '16:9', durationSeconds: 2, fps: FPS }} />
  </QueryClientProvider>);
}
