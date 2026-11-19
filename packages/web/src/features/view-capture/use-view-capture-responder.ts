// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';

import { VIEW_CAPTURE_REQUEST_SIGNAL, type ViewCaptureRequestSignal } from '@breatic/shared';
import { agentAccessApi } from '@web/data/api/agent-access';
import { captureView } from '@web/features/view-capture/capture-view';
import { useCurrentUserStore } from '@web/stores/current-user';

/** The longest a background tab holds its answer back. */
const BACKGROUND_WAIT_CAP_MS = 3000;

/**
 * How long a tab holds its answer back: none while it is in front; behind,
 * longer the longer it has been out of sight, so of several open tabs the
 * one looked at last answers first and the server keeps the first answer.
 * @param lastVisibleAt - When this tab was last in front, epoch ms.
 * @returns The wait in ms.
 */
function answerWait(lastVisibleAt: number): number {
  if (document.visibilityState === 'visible') return 0;
  return Math.min(BACKGROUND_WAIT_CAP_MS, 200 + Math.floor((Date.now() - lastVisibleAt) / 1000));
}

/**
 * Whether a stateless payload is a capture request for this user.
 * @param payload - The raw payload.
 * @param userId - Who is signed in.
 * @returns The request, or null.
 */
function requestFor(payload: string, userId: string | undefined): ViewCaptureRequestSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // Non-JSON stateless traffic (space RPC answers) is not a request.
    return null;
  }
  const signal = parsed as Partial<ViewCaptureRequestSignal> | null;
  if (signal?.t !== VIEW_CAPTURE_REQUEST_SIGNAL || userId === undefined || signal.userId !== userId) return null;
  if (typeof signal.requestId !== 'string' || typeof signal.maxEdgePx !== 'number' || typeof signal.maxBytes !== 'number') return null;
  return signal as ViewCaptureRequestSignal;
}

/**
 * Answer an external agent's request to see this user's screen (#1488
 * §19.1): capture the Space in front and upload it, or say none is open.
 * @param provider - The project meta doc's provider.
 * @param activeSpaceId - The Space in front, or null.
 */
export function useViewCaptureResponder(
  provider: Pick<HocuspocusProvider, 'on' | 'off'> | null | undefined,
  activeSpaceId: string | null,
): void {
  const userId = useCurrentUserStore((s) => s.user?.id);
  const active = React.useRef(activeSpaceId);
  active.current = activeSpaceId;
  const lastVisibleAt = React.useRef(Date.now());
  React.useEffect(() => {
    /** Note when this tab is in front. */
    const seen = (): void => {
      if (document.visibilityState === 'visible') lastVisibleAt.current = Date.now();
    };
    document.addEventListener('visibilitychange', seen);
    return (): void => {
      seen();
      document.removeEventListener('visibilitychange', seen);
    };
  }, []);

  React.useEffect(() => {
    if (!provider) return undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    /**
     * Answer a capture request meant for this user.
     * @param data - The stateless message wrapper.
     * @param data.payload - Raw stateless string payload.
     */
    const onStateless = (data: { payload: string }): void => {
      const request = requestFor(data.payload, userId);
      if (request === null) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        void captureView(active.current, { maxEdgePx: request.maxEdgePx, maxBytes: request.maxBytes })
          .then((upload) => agentAccessApi.uploadViewCapture(request.requestId, upload))
          .catch((err: unknown) => {
            // Another tab answered first (409) or the request expired (410);
            // the agent is told "not watching" by the server either way.
            console.warn('view capture not delivered', err);
          });
      }, answerWait(lastVisibleAt.current));
      timers.add(timer);
    };
    provider.on('stateless', onStateless);
    return (): void => {
      provider.off('stateless', onStateless);
      for (const timer of timers) clearTimeout(timer);
    };
  }, [provider, userId]);
}
