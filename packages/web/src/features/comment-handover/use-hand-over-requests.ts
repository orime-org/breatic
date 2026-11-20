// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { commentAssignmentsKey } from '@web/data/api/agent-access';
import { sendSpaceCommentRequest, type CommentRequestBody } from '@web/data/yjs/comment-requests';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';

/** Handing a thread over and taking it back, for one Space. */
export interface HandOverRequests {
  handOver: (threadId: string, connectionId: string) => Promise<void>;
  takeBack: (threadId: string) => Promise<void>;
}

/**
 * Ask collab to hand a thread over or take it back, on the Space's own
 * connection (#1488 §11.9); a refusal or a lost connection says so, and an
 * answered request reads the Space's records again so the label follows.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @param kind - Its type.
 * @returns The two requests.
 */
export function useHandOverRequests(projectId: string, spaceId: string, kind: 'canvas' | 'document'): HandOverRequests {
  const t = useTranslation();
  const failedHandOver = t('commentHandover.handOverFailed');
  const failedTakeBack = t('commentHandover.takeBackFailed');
  const queryClient = useQueryClient();
  const ask = React.useCallback(
    async (body: CommentRequestBody, failed: string): Promise<void> => {
      try {
        const answer = await sendSpaceCommentRequest(projectId, spaceId, kind, body);
        if (!answer.ok) {
          toast.error(failed);
          return;
        }
        await queryClient.invalidateQueries({ queryKey: commentAssignmentsKey(projectId, spaceId) });
      } catch {
        toast.error(failed);
      }
    },
    [projectId, spaceId, kind, queryClient],
  );
  return React.useMemo(
    () => ({
      handOver: (threadId: string, connectionId: string) => ask({ type: 'comment:hand-over', payload: { spaceId, threadId, connectionId } }, failedHandOver),
      takeBack: (threadId: string) => ask({ type: 'comment:cancel-hand-over', payload: { spaceId, threadId } }, failedTakeBack),
    }),
    [ask, spaceId, failedHandOver, failedTakeBack],
  );
}
