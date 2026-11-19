// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useCommentRevealStore } from '@web/stores/comment-reveal';

/** The Space kinds that hold comment threads. */
const COMMENTED = new Set(['canvas', 'document']);

/**
 * Open the comment a link points at (`?space=&comment=`, from a bell row):
 * once the project's Spaces are known, open that Space and ask it to show the
 * thread, or say the comment is gone when its Space is; the address is left
 * without the two parameters either way.
 * @param spaces - The project's Spaces.
 * @param activeId - The Space in front.
 * @param open - Opens a Space's tab.
 * @param ready - Whether the Spaces have loaded.
 */
export function useCommentLinkRouting(
  spaces: readonly ProjectSpace[],
  activeId: string | null,
  open: (spaceId: string) => void,
  ready: boolean,
): void {
  const t = useTranslation();
  const [params, setParams] = useSearchParams();
  const spaceId = params.get('space');
  const threadId = params.get('comment');
  React.useEffect(() => {
    if (!ready || spaceId === null || threadId === null) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('space');
        next.delete('comment');
        return next;
      },
      { replace: true },
    );
    const space = spaces.find((s) => s.id === spaceId);
    if (space === undefined || !COMMENTED.has(space.type)) {
      toast.warning(t('commentLink.gone'));
      return;
    }
    useCommentRevealStore.getState().reveal(spaceId, threadId);
    if (activeId !== spaceId) open(spaceId);
  }, [ready, spaceId, threadId, spaces, activeId, open, setParams, t]);
}
