// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useFollowStore } from '@web/stores/follow';

/**
 * Tell the user once why following stopped (#920): they moved the view or
 * switched Space themselves (info), the leader started following someone
 * (info, naming whom), or the leader went offline (warning).
 * The stop button and leaving the project say nothing; the user did those
 * and sees the bar go. The leader's name comes from the stop, so a leader who
 * has left the member list is still named.
 */
export function useFollowExitToast(): void {
  const t = useTranslation();
  const stopped = useFollowStore((s) => s.stopped);
  // Each stop is told once, keyed by its seq, however often this re-renders.
  const told = React.useRef(stopped?.seq ?? 0);
  React.useEffect(() => {
    if (stopped === null || stopped.seq === told.current) return;
    told.current = stopped.seq;
    if (stopped.reason === 'viewport') toast.info(t('members.follow.stoppedViewport'));
    else if (stopped.reason === 'space') toast.info(t('members.follow.stoppedSpace'));
    else if (stopped.reason === 'leaderFollows') {
      toast.info(stopped.other === 'you'
        ? t('members.follow.stoppedLeaderFollowsYou', { name: stopped.name })
        : t('members.follow.stoppedLeaderFollows', { name: stopped.name, other: stopped.other.name }));
    } else if (stopped.reason === 'offline') toast.warning(t('members.follow.stoppedOffline', { name: stopped.name }));
  }, [stopped, t]);
}
