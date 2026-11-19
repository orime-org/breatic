// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCommentRevealStore } from '@web/stores/comment-reveal';

/**
 * Show the comment thread this Space was asked to, once its content is in:
 * the thread when the Space holds it, otherwise a word that it is gone.
 * @param spaceId - This Space.
 * @param ready - Whether its content has loaded.
 * @param holds - Whether it holds a thread.
 * @param show - Brings a thread into view and opens it.
 */
export function useCommentRevealReceiver(
  spaceId: string,
  ready: boolean,
  holds: (threadId: string) => boolean,
  show: (threadId: string) => void,
): void {
  const t = useTranslation();
  const request = useCommentRevealStore((s) => s.request);
  React.useEffect(() => {
    if (!ready || request?.spaceId !== spaceId) return;
    const threadId = useCommentRevealStore.getState().take(spaceId);
    if (threadId === null) return;
    if (holds(threadId)) show(threadId);
    else toast.warning(t('commentLink.gone'));
  }, [ready, request, spaceId, holds, show, t]);
}
