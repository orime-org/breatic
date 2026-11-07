// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';

import { timelineApi } from '@web/data/api/timeline';

/** A preview address being fetched, fetched, or refused. */
export interface WebAnimationPreviewUrl { url: string | null; failed: boolean; refresh: () => void }

/**
 * Fetch a signed preview address for one source version, once per mount (inner#1711 design §7.3). The address only
 * loads the page, so a loaded page keeps working after it expires: it is not fetched again on window focus, on the
 * Space-task signal or at its expiry, only when `refresh` asks for a new one.
 * @param projectId - The Project the page reads it through.
 * @param sourceVersionId - The source version.
 * @returns The address, whether the request failed, and a refresh.
 * @throws {never} Never.
 */
export function useWebAnimationPreviewUrl(projectId: string, sourceVersionId: string): WebAnimationPreviewUrl {
  const [attempt, setAttempt] = React.useState(0);
  const request = `${projectId}:${sourceVersionId}:${attempt}`;
  const [answer, setAnswer] = React.useState<{ request: string; url: string | null } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    timelineApi.previewUrl(projectId, sourceVersionId, controller.signal).then(
      ({ url }) => { if (!controller.signal.aborted) setAnswer({ request, url }); },
      // The note under the preview says the copy is unavailable and offers a retry.
      () => { if (!controller.signal.aborted) setAnswer({ request, url: null }); },
    );
    return () => controller.abort();
  }, [projectId, sourceVersionId, request]);
  const refresh = React.useCallback((): void => setAttempt((value) => value + 1), []);
  const current = answer?.request === request ? answer : null;
  return { url: current?.url ?? null, failed: current !== null && current.url === null, refresh };
}
