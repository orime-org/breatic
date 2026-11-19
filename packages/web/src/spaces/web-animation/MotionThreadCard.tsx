// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import type { ThreadData } from '@blocknote/core/comments';
import type { YjsThreadStore } from '@blocknote/core/yjs';
import type { ProjectRole } from '@breatic/shared';

import { useUserProfiles } from '@web/data/use-user-profiles';
import { toast } from '@web/lib/toast';
import { useTranslation } from '@web/i18n/use-translation';
import { DocumentCommentCard } from '@web/spaces/document/DocumentCommentCard';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { SpaceFullError } from '@web/spaces/document/document-comment-thread-store';
import { bodyText, type CommentCardView } from '@web/spaces/document/use-comment-cards';
import { formatAnnotationTime } from '@web/spaces/web-animation/MotionAnnotationsPanel';

/** The open thread's card. */
interface MotionThreadCardProps {
  thread: ThreadData;
  timeSeconds: number;
  store: YjsThreadStore;
  myRole: ProjectRole;
  viewerId: string | undefined;
  /** Whether this connection may write annotations now. */
  canWrite: boolean;
  /** What has been written in its reply box and not sent, kept outside the card so it outlives the card. */
  draft: string;
  onDraft: (threadId: string, body: string) => void;
}

/**
 * One annotation thread open over the frame (#1490 design §7.1, §10.1): the Document comment card, with the time it
 * is at where a Document card quotes its words; replies, resolving and reopening write through the Space's thread
 * store, behind its size gate.
 * @param props - The thread and the store it writes through.
 * @param props.thread - The thread.
 * @param props.timeSeconds - Its time in the result.
 * @param props.store - The Space's thread store.
 * @param props.myRole - The user's role.
 * @param props.viewerId - The user's id.
 * @param props.canWrite - Whether annotations may be written now.
 * @param props.draft - Its unsent reply.
 * @param props.onDraft - Keeps its unsent reply.
 * @returns The card.
 * @throws {never} Never.
 */
export function MotionThreadCard({ thread, timeSeconds, store, myRole, viewerId, canWrite, draft, onDraft }: MotionThreadCardProps): React.JSX.Element {
  const t = useTranslation();
  const authorIds = React.useMemo(() => thread.comments.map((comment) => comment.userId), [thread.comments]);
  const profiles = useUserProfiles(authorIds);
  const card = React.useMemo((): CommentCardView => ({
    id: thread.id,
    settled: thread.resolved,
    quote: formatAnnotationTime(timeSeconds),
    media: null,
    entries: thread.comments.filter((comment) => comment.deletedAt === undefined).map((comment) => ({
      id: comment.id,
      author: profiles.get(comment.userId)?.name ?? null,
      authorId: comment.userId,
      avatarUrl: profiles.get(comment.userId)?.avatarUrl ?? null,
      body: bodyText(comment.body),
      createdAt: comment.createdAt,
      fromAgent: false,
    })),
  }), [thread, timeSeconds, profiles]);
  /**
   * Run one write; a full Space has said so in its own toast.
   * @param write - The write.
   * @returns Whether it landed.
   */
  const run = React.useCallback(async (write: () => Promise<unknown>): Promise<boolean> => {
    try {
      await write();
      return true;
    } catch (err) {
      if (!(err instanceof SpaceFullError)) toast.error(t('spaces.webAnimation.annotationFailed'));
      return false;
    }
  }, [t]);
  const onReply = React.useCallback(async (threadId: string, body: string): Promise<boolean> => {
    if (body.trim() === '') return false;
    return run(() => store.addComment({ threadId, comment: { body: asCommentBody(body.trim()) as never } }));
  }, [run, store]);
  const onResolve = React.useCallback((threadId: string): void => { void run(() => store.resolveThread({ threadId })); }, [run, store]);
  const onReopen = React.useCallback((threadId: string): void => { void run(() => store.unresolveThread({ threadId })); }, [run, store]);
  const onDelete = React.useCallback((threadId: string): void => { void run(() => store.deleteThread({ threadId })); }, [run, store]);
  const onDeleteReply = React.useCallback((threadId: string, commentId: string): void => { void run(() => store.deleteComment({ threadId, commentId })); }, [run, store]);
  return <div data-testid='motion-thread-card' className='w-72'>
    <DocumentCommentCard card={card} marked={false} reading myRole={canWrite ? myRole : 'viewer'} viewerId={viewerId} draft={draft} onDraft={onDraft}
      onReply={onReply} onResolve={onResolve} onReopen={onReopen} onDelete={onDelete} onDeleteReply={onDeleteReply} />
  </div>;
}
