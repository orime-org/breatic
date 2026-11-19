// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';

import type { CommentMention } from '@breatic/shared';
import { useProjectMembers } from '@web/data/use-project-members';
import { settleMentions } from '@web/features/comment-mention/mention-text';

/**
 * Settle a comment's mentions against the project's current names (#1488
 * §11.6), so a member renamed since keeps their mention while `@` plus the
 * new name is in the text.
 * @param projectId - The project the comment is in.
 * @returns A function from the saved words and the box's mentions to the ones to store.
 */
export function useSettleMentions(
  projectId: string,
): (text: string, candidates: readonly CommentMention[] | undefined) => CommentMention[] {
  const { members } = useProjectMembers(projectId);
  return React.useCallback(
    (text, candidates) => {
      const names = new Map(members.map((m) => [m.userId, m.name]));
      return settleMentions(text, candidates ?? [], (id) => names.get(id));
    },
    [members],
  );
}
