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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { TimelineWebPreview, type TimelineWebEntry } from '@web/spaces/timeline/TimelineWebPreview';
import { TimelineWebResultPreview } from '@web/spaces/timeline/TimelineWebResultPreview';
import type { WebInstanceState } from '@web/spaces/timeline/web-animation-host';
import { SRC_A, boundTo, webClip } from '@web/data/yjs/__tests__/timeline-web-fixtures';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, previewUrl: vi.fn() } };
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

beforeEach(() => {
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: PREVIEW_URL });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    render(<TimelineWebResultPreview projectId={PROJECT} executionId={EXECUTION} sourceVersionId={SRC_A}
      input={{ prompt: 'Gold dot along an arc', engine: 'deepseek', aspect: '16:9', durationSeconds: 2, fps: FPS }} />);
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
});
