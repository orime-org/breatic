// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chatApi } from '@web/data/api/chat';
import { useRunningTurns } from '@web/stores/running-turns';

/**
 * The conversations the conversation list marks as running (#1394).
 *
 * Two sources. Turns running on this page come from `stores/running-turns`
 * at once. Turns running on another tab or device come from the server, and
 * only an answer fetched during this open of the list counts: React Query
 * hands back the last open's cached answer first, and that can name turns
 * that ended long ago. A failed last fetch counts for nothing until the next
 * one succeeds, since React Query keeps the older data beside the error.
 *
 * The list is always mounted and opening it only flips `enabled`, which
 * fetches only stale data, so `staleTime` is 0. React Query refetches when the
 * tab becomes visible; two windows side by side never change visibility, so a
 * window `focus` listener refetches as well, joining a request already in
 * flight rather than cancelling it, the way React Query's own does. While the
 * last answer names any conversation it is asked again on the server's poll
 * interval, and a turn that ends here asks again at once.
 * @param projectId - The project whose conversations are listed.
 * @param open - Whether the list is open.
 * @returns The ids to mark.
 */
export function useRunningConversations(projectId: string, open: boolean): ReadonlySet<string> {
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => ['chat', 'running', projectId] as const, [projectId]);
  // When this open began, set in the same render that sees the list open, so
  // no render ever pairs a new open with the last open's time.
  const [opening, setOpening] = React.useState(() => ({ open, at: open ? Date.now() : 0 }));
  if (opening.open !== open) setOpening({ open, at: open ? Date.now() : 0 });
  const openedAt = opening.open === open ? opening.at : 0;

  // Without it there is no interval to poll on; opening and focus still ask.
  const { data: config } = useQuery({
    queryKey: ['chat', 'stream-config'],
    queryFn: () => chatApi.streamConfig(),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });
  const pollMs = config?.runningPollIntervalMs ?? null;

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => chatApi.running(projectId, signal),
    enabled: open,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 && pollMs !== null ? pollMs : false),
  });

  const { refetch } = query;
  React.useEffect(() => {
    if (!open) return;
    /** Ask again when this window gets focus back. */
    const onFocus = (): void => {
      void refetch({ cancelRefetch: false });
    };
    window.addEventListener('focus', onFocus);
    return (): void => window.removeEventListener('focus', onFocus);
  }, [open, refetch]);

  // A turn that ended here: the last answer still listed it, so asking now
  // drops the mark without waiting for the next poll.
  React.useEffect(
    () =>
      useRunningTurns.subscribe((next, prev) => {
        const ended = Object.keys(prev.byConversation).some((id) => !next.byConversation[id]);
        if (ended) void queryClient.invalidateQueries({ queryKey });
      }),
    [queryClient, queryKey],
  );

  const local = useRunningTurns((s) => s.byConversation);
  const { data, dataUpdatedAt, isError } = query;
  // Decided outside the memo, so a poll that brings back the same ids (React
  // Query keeps the same array for equal data) keeps the same set and the
  // memoized list does not redraw.
  const fresh = open && !isError && data !== undefined && openedAt > 0 && dataUpdatedAt >= openedAt;
  const shown = fresh ? data : undefined;
  return React.useMemo(() => {
    const ids = new Set(Object.keys(local));
    for (const id of shown ?? []) ids.add(id);
    return ids;
  }, [local, shown]);
}
