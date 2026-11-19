// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCommentRevealStore } from '@web/stores/comment-reveal';

/** Where a Space stands on a thread: holds it, does not, or has not read its content in yet. */
export type ThreadPresence = 'here' | 'gone' | 'wait';

/**
 * Show the comment thread this Space was asked to, once its content is in:
 * the thread when the Space holds it, otherwise a word that it is gone. While
 * the Space is still reading its content in, the request waits for the next
 * change.
 * @param spaceId - This Space.
 * @param ready - Whether its content has loaded.
 * @param find - Where the Space stands on a thread.
 * @param show - Brings a thread into view and opens it.
 */
export function useCommentRevealReceiver(
  spaceId: string,
  ready: boolean,
  find: (threadId: string) => ThreadPresence,
  show: (threadId: string) => void,
): void {
  const t = useTranslation();
  const request = useCommentRevealStore((s) => s.request);
  React.useEffect(() => {
    if (!ready || request?.spaceId !== spaceId) return;
    const presence = find(request.threadId);
    if (presence === 'wait') return;
    const threadId = useCommentRevealStore.getState().take(spaceId);
    if (threadId === null) return;
    if (presence === 'here') show(threadId);
    else toast.warning(t('commentLink.gone'));
  }, [ready, request, spaceId, find, show, t]);
}
