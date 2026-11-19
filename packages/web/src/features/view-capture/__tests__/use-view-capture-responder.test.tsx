// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Answering an external agent's request to see the owner's screen (#1488
 * §19.1): only the owner's own browser answers, with the Space in front.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIEW_CAPTURE_REQUEST_SIGNAL } from '@breatic/shared';
import { useViewCaptureResponder } from '@web/features/view-capture/use-view-capture-responder';
import { useCurrentUserStore } from '@web/stores/current-user';

const capture = vi.hoisted(() => ({ captureView: vi.fn() }));
vi.mock('@web/features/view-capture/capture-view', () => capture);

const api = vi.hoisted(() => ({ uploadViewCapture: vi.fn() }));
vi.mock('@web/data/api/agent-access', async (real) => ({
  ...(await real<typeof import('@web/data/api/agent-access')>()),
  agentAccessApi: api,
}));

type Listener = (d: { payload: string }) => void;

/**
 * A meta provider double the test can speak through.
 * @returns The provider and a sender.
 */
function providerDouble(): { provider: { on: (e: string, f: Listener) => void; off: (e: string, f: Listener) => void }; send: (p: unknown) => void } {
  const listeners = new Set<Listener>();
  return {
    provider: { on: (_e, f) => listeners.add(f), off: (_e, f) => listeners.delete(f) },
    send: (p) => {
      for (const f of listeners) f({ payload: JSON.stringify(p) });
    },
  };
}

const REQUEST = { t: VIEW_CAPTURE_REQUEST_SIGNAL, requestId: 'r1', userId: 'me', maxEdgePx: 1568, maxBytes: 917504 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: { id: 'me' } as never });
  capture.captureView.mockResolvedValue({ image: new Blob(['x'], { type: 'image/webp' }), view: { nodeIds: ['n1'] } });
  api.uploadViewCapture.mockResolvedValue(undefined);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useViewCaptureResponder', () => {
  it('captures the Space in front within the limits and uploads it', async () => {
    const { provider, send } = providerDouble();
    renderHook(() => useViewCaptureResponder(provider as never, 's1'));
    await act(async () => {
      send(REQUEST);
      await vi.runAllTimersAsync();
    });
    expect(capture.captureView).toHaveBeenCalledWith('s1', { maxEdgePx: 1568, maxBytes: 917504 });
    expect(api.uploadViewCapture).toHaveBeenCalledWith('r1', expect.objectContaining({ view: { nodeIds: ['n1'] } }));
  });

  it('ignores a request meant for someone else', async () => {
    const { provider, send } = providerDouble();
    renderHook(() => useViewCaptureResponder(provider as never, 's1'));
    await act(async () => {
      send({ ...REQUEST, userId: 'other' });
      send({ t: 'credits:changed', projectId: 'p' });
      await vi.runAllTimersAsync();
    });
    expect(capture.captureView).not.toHaveBeenCalled();
  });

  it('answers with no Space in front too', async () => {
    const { provider, send } = providerDouble();
    renderHook(() => useViewCaptureResponder(provider as never, null));
    await act(async () => {
      send(REQUEST);
      await vi.runAllTimersAsync();
    });
    expect(capture.captureView).toHaveBeenCalledWith(null, { maxEdgePx: 1568, maxBytes: 917504 });
  });

  it('lets a tab in front answer before one in the background', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const { provider, send } = providerDouble();
    renderHook(() => useViewCaptureResponder(provider as never, 's1'));
    await act(async () => {
      send(REQUEST);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(capture.captureView).not.toHaveBeenCalled();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(capture.captureView).toHaveBeenCalled();
  });

  it('stops listening when unmounted', async () => {
    const { provider, send } = providerDouble();
    const { unmount } = renderHook(() => useViewCaptureResponder(provider as never, 's1'));
    unmount();
    await act(async () => {
      send(REQUEST);
      await vi.runAllTimersAsync();
    });
    expect(capture.captureView).not.toHaveBeenCalled();
  });
});
