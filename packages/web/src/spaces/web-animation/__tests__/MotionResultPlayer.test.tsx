// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Motion player keeps one bridge host for its life while the Space shows result after result in it, and results
 * carry different frame rates; the play bar's frame is mapped to the page's clock with the frame rate of the result
 * shown now, not the first one.
 */

import * as React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { timelineApi } from '@web/data/api/timeline';
import type * as TimelineApiModule from '@web/data/api/timeline';
import { MotionResultPlayer } from '@web/spaces/web-animation/MotionResultPlayer';

vi.mock('@web/data/api/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof TimelineApiModule>();
  return { ...actual, timelineApi: { ...actual.timelineApi, previewUrl: vi.fn(), limits: vi.fn() } };
});
vi.mock('@hyperframes/player', () => ({}));

const PROJECT = '60000000-0000-4000-8000-000000000001';
const EXECUTION = '90000000-0000-4000-8000-000000000002';
const SOURCE = '50000000-0000-4000-8000-000000000003';

beforeEach(() => {
  vi.mocked(timelineApi.previewUrl).mockReset().mockResolvedValue({ url: 'https://preview.example/web-animation/token/index.html' });
  // The limits never arrive: no load timeout runs and no address is shared between cases.
  vi.mocked(timelineApi.limits).mockReset().mockReturnValue(new Promise(() => {}));
  const get = customElements.get.bind(customElements);
  vi.spyOn(customElements, 'get').mockImplementation((name) => (name === 'hyperframes-player' ? HTMLElement : get(name)));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Motion result player', () => {
  it('maps the play bar frame with the frame rate of the result shown now', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = (num: number): React.JSX.Element => <QueryClientProvider client={client}>
      <MotionResultPlayer projectId={PROJECT} executionId={EXECUTION} sourceVersionId={SOURCE} input={{ durationSeconds: 10, fps: { num, den: 1 } }} frame={24} />
    </QueryClientProvider>;
    const { rerender } = render(view(24));
    await waitFor(() => expect(document.querySelector('hyperframes-player')).not.toBeNull());
    const element = document.querySelector('hyperframes-player') as HTMLElement;
    const iframe = document.createElement('iframe');
    const posted = vi.fn();
    const frameWindow = { postMessage: posted } as unknown as Window;
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, get: () => frameWindow });
    Object.defineProperty(element, 'iframeElement', { configurable: true, get: () => iframe });
    // The page says its bridge is ready, as `WEB_ANIMATION_BRIDGE_SCRIPT` does.
    const ready = new Event('message');
    Object.defineProperties(ready, { data: { value: { type: 'breatic-bridge-ready' } }, source: { value: frameWindow }, origin: { value: 'null' } });
    act(() => { window.dispatchEvent(ready); });
    const lastSeekTime = (): unknown => posted.mock.calls.map((call) => call[0] as { type?: string; time?: unknown })
      .filter((message) => message.type === 'breatic-seek').at(-1)?.time;
    expect(lastSeekTime()).toBe(1);

    rerender(view(12));
    expect(lastSeekTime()).toBe(2);
  });
});
