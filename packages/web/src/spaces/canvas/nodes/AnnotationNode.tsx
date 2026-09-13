// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A collaboration sticky: what somebody said about this part of the canvas,
 * the replies under it, and a box to answer in.
 *
 * Not a content node — it holds no payload and generates nothing, so it draws
 * no handles: a sticky is about the canvas, never an input to it (#1881 §8.5).
 * The connection rule that refuses an edge to one stays as the backstop for
 * edges that already exist.
 *
 * Every write goes through `canvas-space`, and every draft through
 * `reduceDraft` — one box open at a time across the whole sticky, whether it
 * is a new reply or a rewrite of something already posted.
 */

import * as React from 'react';

import { Avatar, AvatarFallback } from '@web/components/ui/avatar';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { useProjectMembers } from '@web/data/use-project-members';
import {
  addReply,
  editAnnotationBody,
  editReply,
  removeNode,
  removeReply,
} from '@web/data/yjs/canvas-space';
import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { AnnotationEntry } from '@web/spaces/canvas/annotation/AnnotationEntry';
import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftAction,
  type DraftState,
} from '@web/spaces/canvas/annotation/draft-state';
import { annotationRights } from '@web/spaces/canvas/annotation/rights';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Which entry the open draft belongs to: the body, or one reply by id. */
type DraftTarget = { kind: 'body' } | { kind: 'reply'; id: string } | null;

interface AnnotationNodeProps {
  data: AnnotationNodeView;
  selected?: boolean;
  locked?: boolean;
}

/**
 * Draw a sticky and everything said on it.
 * @param root0 - Annotation node props.
 * @param root0.data - The sticky: body, author, time, edits, replies.
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, showing the lock indicator.
 * @returns The collaboration sticky node element.
 */
export const AnnotationNode = React.memo(function AnnotationNode({
  data,
  selected,
  locked,
}: AnnotationNodeProps): React.JSX.Element {
  const t = useTranslation();
  const nodeId = React.useContext(NodeIdContext);
  const { projectId, spaceId, readOnly, myRole } = useCanvasContext();
  const viewerId = useCurrentUserStore((s) => s.user?.id);
  const { members } = useProjectMembers(projectId);

  const [draft, setDraft] = React.useState<DraftState>(CLOSED_DRAFT);
  const [target, setTarget] = React.useState<DraftTarget>(null);
  // The reducer needs the draft as it stands at the moment of the event, and a
  // commit has to be written from the handler — a state updater must stay pure,
  // and under StrictMode it runs twice.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const targetRef = React.useRef(target);
  targetRef.current = target;

  const rightsFor = React.useCallback(
    // A read-only viewer is a viewer whatever else the role says: the document
    // refuses their writes, so offering the controls would put buttons on
    // screen that do nothing.
    (authorId: string) =>
      annotationRights({
        role: readOnly ? 'viewer' : myRole,
        viewerId,
        authorId,
      }),
    [readOnly, myRole, viewerId],
  );

  const authorOf = React.useCallback(
    (authorId: string) => {
      const member = members.find((m) => m.userId === authorId);
      return { name: member?.name ?? '', avatarUrl: member?.avatarUrl };
    },
    [members],
  );

  const write = React.useCallback(
    (at: DraftTarget, use: DraftState['use'], text: string): void => {
      if (nodeId === null) return;
      const now = Date.now();
      if (use === 'reply') {
        addReply(projectId, spaceId, nodeId, {
          id: crypto.randomUUID(),
          content: text,
          createdBy: viewerId ?? '',
          createdAt: now,
        });
        return;
      }
      if (at?.kind === 'reply') {
        editReply(projectId, spaceId, nodeId, at.id, text, now);
        return;
      }
      editAnnotationBody(projectId, spaceId, nodeId, text, now);
    },
    [nodeId, projectId, spaceId, viewerId],
  );

  const apply = React.useCallback(
    (action: DraftAction): void => {
      const next = reduceDraft(draftRef.current, action);
      if (next === draftRef.current) return;
      draftRef.current = next;
      setDraft(next);
      if (next.commit !== undefined) {
        write(targetRef.current, next.use, next.commit);
      }
      if (next.mode === 'closed') {
        targetRef.current = null;
        setTarget(null);
      }
    },
    [write],
  );

  const open = React.useCallback(
    (at: DraftTarget, use: DraftState['use'], text: string): void => {
      targetRef.current = at;
      setTarget(at);
      apply({ type: 'open', use, text });
    },
    [apply],
  );

  // A draft open against something a collaborator just deleted has nowhere to
  // land. The reducer closes it and marks why, so the sticky can say so rather
  // than leaving the words in a box that writes nowhere.
  React.useEffect(() => {
    const at = targetRef.current;
    if (at?.kind !== 'reply') return;
    if (data.replies.some((reply) => reply.id === at.id)) return;
    apply({ type: 'targetGone' });
  }, [data.replies, apply]);

  const bodyRights = rightsFor(data.createdBy);
  const bodyAuthor = authorOf(data.createdBy);
  const editingBody =
    draft.mode !== 'closed' && draft.use === 'edit' && target?.kind === 'body'
      ? draft.text
      : undefined;
  const composing =
    draft.mode !== 'closed' && draft.use === 'reply' ? draft.text : '';
  const mine = authorOf(viewerId ?? '');

  return (
    <NodeShell
      selected={selected}
      locked={locked}
      className={cn('w-[200px] border-note-border bg-note text-note-foreground')}
      testId='annotation-node'
    >
      <AnnotationEntry
        content={data.content}
        createdAt={data.createdAt}
        editedAt={data.editedAt}
        authorName={bodyAuthor.name}
        authorAvatarUrl={bodyAuthor.avatarUrl}
        rights={bodyRights}
        editing={editingBody}
        testId='annotation-node-body'
        onEdit={() => open({ kind: 'body' }, 'edit', data.content)}
        onDelete={() => {
          if (nodeId !== null) removeNode(projectId, spaceId, nodeId);
        }}
        onEditingChange={(text) => apply({ type: 'type', text })}
        onSave={() => apply({ type: 'save' })}
        onCancel={() => apply({ type: 'cancel' })}
      />

      {data.replies.length === 0 ? null : (
        // A sticky is a fixed landmark on the canvas; a thread of twenty
        // answers must not turn it into a column taller than the viewport
        // (A20). The cap is measured on a real board rather than reasoned
        // about — it holds roughly four short replies.
        <ScrollArea
          scrollbars='vertical'
          className='max-h-[180px] border-t border-note-border'
          data-testid='annotation-node-replies'
        >
          {data.replies.map((reply) => {
            const author = authorOf(reply.createdBy);
            const editing =
              draft.mode !== 'closed' &&
              draft.use === 'edit' &&
              target?.kind === 'reply' &&
              target.id === reply.id
                ? draft.text
                : undefined;
            return (
              <AnnotationEntry
                key={reply.id}
                content={reply.content}
                createdAt={reply.createdAt}
                editedAt={reply.editedAt}
                authorName={author.name}
                authorAvatarUrl={author.avatarUrl}
                rights={rightsFor(reply.createdBy)}
                editing={editing}
                testId={`annotation-node-reply-${reply.id}`}
                onEdit={() =>
                  open({ kind: 'reply', id: reply.id }, 'edit', reply.content)
                }
                onDelete={() => {
                  if (nodeId !== null) {
                    removeReply(projectId, spaceId, nodeId, reply.id);
                  }
                }}
                onEditingChange={(text) => apply({ type: 'type', text })}
                onSave={() => apply({ type: 'save' })}
                onCancel={() => apply({ type: 'cancel' })}
              />
            );
          })}
        </ScrollArea>
      )}

      {draft.targetGone === true ? (
        <p
          className='border-t border-note-border px-2 py-1.5 text-2xs text-muted-foreground'
          data-testid='annotation-node-target-gone'
        >
          {t('canvas.annotation.targetGone')}
        </p>
      ) : null}

      {bodyRights.canPost ? (
        <div className='flex items-start gap-1.5 border-t border-note-border px-2 py-1.5'>
          <Avatar className='h-5 w-5 shrink-0'>
            <AvatarFallback className='text-2xs'>
              {(mine.name || '?').slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <Textarea
            rows={1}
            value={composing}
            placeholder={t('canvas.annotation.replyPlaceholder')}
            className='min-h-0 resize-none text-xs'
            data-testid='annotation-node-reply-input'
            onFocus={() => {
              if (draft.mode === 'closed') open(null, 'reply', '');
            }}
            onChange={(e) => apply({ type: 'type', text: e.target.value })}
            onCompositionStart={() => apply({ type: 'compositionStart' })}
            onCompositionEnd={() => apply({ type: 'compositionEnd' })}
            onKeyDown={(e) => {
              // Shift+Enter is a line inside the reply; Enter posts it, unless
              // the reducer says this keystroke belongs to an IME.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                apply({ type: 'enter' });
                return;
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                apply({ type: 'escape' });
              }
            }}
            onBlur={() => apply({ type: 'blur' })}
          />
          <Button
            size='sm'
            className='h-6 shrink-0 text-2xs'
            disabled={composing.trim().length === 0}
            data-testid='annotation-node-reply-post'
            // A pointer press on a button takes focus off the box, and the
            // box's blur throws the draft away — so the press has to reach the
            // reducer before the blur does.
            onMouseDown={(e) => {
              e.preventDefault();
              apply({ type: 'enter' });
            }}
          >
            {t('canvas.annotation.save')}
          </Button>
        </div>
      ) : null}
    </NodeShell>
  );
});
