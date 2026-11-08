// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { timelineApi } from '@web/data/api/timeline';

/** A preview address being fetched, fetched, or refused. */
export interface WebAnimationPreviewUrl { url: string | null; failed: boolean; refresh: () => void }

/** The Timeline limits that decide how long one address may be shared. */
export interface WebAnimationPreviewSharing { previewTokenTtlMs: number; playerLoadTimeoutMs: number }

/** One address shared in this page: the request, and when it was sent on the local clock. */
interface SharedAddress { sentAt: number; answer: Promise<{ url: string }> }

// Shared per Project and source version for the life of the page; an entry is used only within its window.
const sharedAddresses = new Map<string, SharedAddress>();

/**
 * Request an address, through the page-wide share when the limits allow one: a mount reuses the address of a request
 * sent less than the signature validity less the load timeout ago, so a page it loads can still read it; a refresh
 * always asks again and replaces the shared one.
 * @param projectId - The Project.
 * @param sourceVersionId - The source version.
 * @param fresh - Whether to ask again whatever is shared.
 * @param sharing - The limits; none shares nothing.
 * @param signal - Aborts an unshared request.
 * @returns The request's answer.
 * @throws {never} Never; the answer rejects when the request fails.
 */
function requestAddress(projectId: string, sourceVersionId: string, fresh: boolean, sharing: WebAnimationPreviewSharing | undefined, signal: AbortSignal): Promise<{ url: string }> {
  const windowMs = sharing === undefined ? 0 : sharing.previewTokenTtlMs - sharing.playerLoadTimeoutMs;
  if (windowMs <= 0) return timelineApi.previewUrl(projectId, sourceVersionId, signal);
  const id = `${projectId}:${sourceVersionId}`;
  const now = Date.now();
  const current = sharedAddresses.get(id);
  if (!fresh && current !== undefined && now < current.sentAt + windowMs) return current.answer;
  // A shared request serves later mounts too, so leaving the one that sent it does not abort it.
  const entry: SharedAddress = { sentAt: now, answer: timelineApi.previewUrl(projectId, sourceVersionId, new AbortController().signal) };
  sharedAddresses.set(id, entry);
  // A refused request is not shared; the next mount asks again.
  entry.answer.catch(() => { if (sharedAddresses.get(id) === entry) sharedAddresses.delete(id); });
  return entry.answer;
}

/**
 * Fetch a signed preview address for one source version (inner#1711 design §7.3 "address"). The address only loads
 * the page, so a loaded page keeps working after it expires: it is not fetched again on window focus, on the
 * Space-task signal, at its expiry or when a hidden Space tab is shown again, only when `refresh` asks for a new one.
 * With the Timeline limits, mounts of one source version in this page share one address from when its request was
 * sent until its validity less the load timeout; without them each mount asks for its own.
 * @param projectId - The Project the page reads it through.
 * @param sourceVersionId - The source version.
 * @param sharing - The signature validity and player load timeout, once the Timeline limits are read.
 * @returns The address, whether the request failed, and a refresh.
 * @throws {never} Never.
 */
export function useWebAnimationPreviewUrl(projectId: string, sourceVersionId: string, sharing?: WebAnimationPreviewSharing): WebAnimationPreviewUrl {
  const [attempt, setAttempt] = React.useState(0);
  const request = `${projectId}:${sourceVersionId}:${attempt}`;
  const [answer, setAnswer] = React.useState<{ request: string; url: string | null } | null>(null);
  // A hidden Space tab re-runs this effect when shown; an address already answered keeps its page loading.
  const answered = React.useRef<string | null>(null);
  // The limits are read when a request is made; arriving later they do not ask again.
  const share = React.useRef(sharing);
  share.current = sharing;
  React.useEffect(() => {
    if (answered.current === request) return;
    let live = true;
    const controller = new AbortController();
    requestAddress(projectId, sourceVersionId, attempt > 0, share.current, controller.signal).then(
      ({ url }) => { if (live) { answered.current = request; setAnswer({ request, url }); } },
      // The note under the preview says the copy is unavailable and offers a retry.
      () => { if (live) { answered.current = request; setAnswer({ request, url: null }); } },
    );
    return () => { live = false; controller.abort(); };
  }, [projectId, sourceVersionId, attempt, request]);
  const refresh = React.useCallback((): void => setAttempt((value) => value + 1), []);
  const current = answer?.request === request ? answer : null;
  return { url: current?.url ?? null, failed: current !== null && current.url === null, refresh };
}
