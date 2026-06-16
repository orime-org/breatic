// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { projectsApi } from '@web/data/api/projects';

/**
 * Record that the user opened this project — fires `POST /projects/:id/opened`
 * once when `enabled` becomes true, floating the project to the top of the
 * cross-studio "Recent" landing feed.
 *
 * StrictMode-safe: a ref keyed by project id guards React's
 * mount → cleanup → remount double-invoke, so exactly ONE POST fires per
 * project (the resource-hook discipline, [[feedback_strictmode_resource_hook]]).
 * Best-effort — recording an open must never disrupt the page, so a failure is
 * swallowed (and the guard reset so a genuine later remount can retry). On
 * success the Recent feed query is invalidated so the just-opened project
 * surfaces (and re-sorts to the top) the next time the landing renders.
 * @param projectId - the bare project uuid (the route's resolved id).
 * @param enabled - gate: record only once the project has loaded (accessible).
 */
export function useRecordProjectOpen(
  projectId: string,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  const recordedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    // The `demo` route is a placeholder shell, not a real project to record.
    if (projectId === 'demo') return;
    if (recordedRef.current === projectId) return;
    recordedRef.current = projectId;
    projectsApi
      .recordOpen(projectId)
      .then(() => {
        void queryClient.invalidateQueries({
          queryKey: ['studios', 'recent'],
        });
      })
      .catch(() => {
        // Non-critical: reset the guard so a genuine later remount can retry.
        recordedRef.current = null;
      });
  }, [projectId, enabled, queryClient]);
}
