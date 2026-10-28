// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where every write to a comment thread ends (#18).
 *
 * All of them can be refused. The thread store asks its own auth before each
 * one, so a control drawn by mistake fails rather than damaging anything; and
 * a thread a peer settled, deleted, or whose words a peer removed is gone by
 * the time the press lands.
 *
 * Whether that happens is not ours to promise — a peer may do what they like
 * with their own document. Whether the reader is told is ours, and it is the
 * whole of what this does: a press that changes nothing and says nothing is
 * the one answer a card must never give.
 *
 * One hook rather than a `catch` per call site, so the answer cannot drift
 * between the panel's five writes and the box's one.
 */

import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

/** Sees a write through, saying so if it was refused. */
export type CommentWrite = <T>(written: Promise<T>) => Promise<T | undefined>;

/**
 * The one way a comment write ends.
 * @returns A function that runs a write and answers for it.
 */
export function useCommentWrite(): CommentWrite {
  const t = useTranslation();
  return React.useCallback(
    <T,>(written: Promise<T>): Promise<T | undefined> =>
      written.catch((reason: unknown) => {
        toast.error(t('spaces.document.comment.writeFailed'));
        // The reader is told what happened; this is for whoever has to work
        // out why, and the reason is the store's own.
        console.error('a comment write was refused', reason);
        return undefined;
      }),
    [t],
  );
}
