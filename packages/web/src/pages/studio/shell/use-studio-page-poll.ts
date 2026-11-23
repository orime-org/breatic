// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { STUDIO_PAGE_POLL_DEFAULT_MS, UPLOAD_STATUS_MAX_KEYS } from '@breatic/shared';

import { studioPageApi, type StudioPagePoll } from '@web/data/api/studio-page';
import { settleUploadEnding, waitingUploadKeys } from '@web/data/upload/upload-status';

/**
 * The Studio page's one poll (#1580). It asks once on mount, then again `nextPollMs` after each answer, with the
 * uploads the page waits for. The first answer is the baseline, and the bell and the Studio's transfer are read once
 * more against it; a later one reads the bell again when its count or newest time moved, and the Studio's transfer
 * when the offer changed, and every ended upload goes to its waiter.
 * One request carries at most `UPLOAD_STATUS_MAX_KEYS` keys, starting further on each round, so every key is asked
 * about in turn however many wait. A hidden tab pauses it, showing the tab again asks at once, and leaving the page stops it. One request is out at a
 * time, and an answer that comes back after the tab was hidden or the page went changes nothing. The bell is the
 * person's own, so its last answer carries over when the page moves to another Studio; the transfer section reads its
 * Studio's offer itself when it mounts.
 * @param slug - The Studio the page shows, or null on the Recent page.
 */
export function useStudioPagePoll(slug: string | null): void {
  const queryClient = useQueryClient();
  const lastBell = useRef<StudioPagePoll['notifications'] | null>(null);

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: StudioPagePoll | null = null;
    let nextMs = STUDIO_PAGE_POLL_DEFAULT_MS;
    let offset = 0;

    /**
     * The keys this round asks about.
     * @returns At most one request's worth, starting where the last round stopped.
     */
    const roundKeys = (): string[] => {
      const waiting = waitingUploadKeys();
      if (waiting.length <= UPLOAD_STATUS_MAX_KEYS) return waiting;
      const start = offset % waiting.length;
      offset = start + UPLOAD_STATUS_MAX_KEYS;
      return [...waiting, ...waiting].slice(start, start + UPLOAD_STATUS_MAX_KEYS);
    };

    /**
     * Whether the poll may send now.
     * @returns True while the page is here and its tab shown.
     */
    const running = (): boolean => !stopped && document.visibilityState !== 'hidden';

    /** Ask again once the interval has passed. */
    const schedule = (): void => {
      clearTimeout(timer);
      if (running()) timer = setTimeout(() => void ask(), nextMs);
    };

    /**
     * Act on one answer.
     * @param answer - The answer.
     */
    const take = (answer: StudioPagePoll): void => {
      const before = last;
      const bellBefore = lastBell.current;
      last = answer;
      lastBell.current = answer.notifications;
      nextMs = answer.nextPollMs;
      // A first answer is the baseline. The panes read at mount on their own, in no order with this request, so each is
      // read once more after it: what they show is then never older than the baseline every later answer is held to.
      if (bellBefore === null || JSON.stringify(bellBefore) !== JSON.stringify(answer.notifications)) {
        void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread'] });
      }
      if (slug !== null && (before === null || JSON.stringify(before.transfer) !== JSON.stringify(answer.transfer))) {
        void queryClient.invalidateQueries({ queryKey: ['studio-transfer', 'live', slug] });
      }
      for (const status of answer.uploads) settleUploadEnding(status);
    };

    /** Send one request, unless one is out or the poll is paused or stopped. */
    const ask = async (): Promise<void> => {
      if (inFlight || !running()) return;
      inFlight = true;
      try {
        const answer = await studioPageApi.poll(slug, roundKeys());
        if (running()) take(answer);
      } catch {
        // A failed round is tried again after the last named interval; the answers say what changed.
      } finally {
        inFlight = false;
      }
      schedule();
    };

    /** Pause when the tab hides, and ask at once when it shows again. */
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (timer === undefined && !inFlight) void ask();
    };

    document.addEventListener('visibilitychange', onVisibility);
    void ask();
    return (): void => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [queryClient, slug]);
}
