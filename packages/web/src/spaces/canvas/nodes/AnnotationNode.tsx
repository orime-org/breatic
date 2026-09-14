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
 * `reduceDraft`. One box at a time across the whole sticky, and that is an
 * invariant the reducer is built on rather than a preference: §6.2's table
 * reads "an entry point does not render while a box is open", and the reducer
 * refuses a second `open` on the strength of it. Left standing, the other
 * entry points wrote into the open draft — measured on a board, typing in the
 * reply box while rewriting the body replaced the body and Enter saved it over
 * the note.
 */

import * as React from 'react';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import { useUserProfiles } from '@web/data/use-user-profiles';
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
import {
  annotationRights,
  NO_ANNOTATION_RIGHTS,
  type AnnotationRights,
} from '@web/spaces/canvas/annotation/rights';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { useCurrentUserStore } from '@web/stores/current-user';

/** Which entry the open draft belongs to: the body, or one reply by id. */
type DraftTarget = { kind: 'body' } | { kind: 'reply'; id: string } | null;

/**
 * How tall the thread may grow before it scrolls.
 *
 * A sticky is a fixed landmark on the board; twenty answers must not turn it
 * into a column taller than the viewport (A20). Measured on a real board
 * rather than reasoned about — it holds roughly four short replies.
 *
 * On the ScrollArea's VIEWPORT, which is the element that scrolls. Put on the
 * Root it clips instead: measured with ten replies, a 179px root over a 468px
 * viewport whose `scrollTop` would not move off 0, and 267px of thread that
 * could not be reached at all.
 */
const REPLIES_MAX_HEIGHT = 'max-h-[180px]';

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

  // Everyone this sticky names, resolved from their accounts rather than the
  // project roster: a note keeps its author's name after they leave the
  // project (A11), and the roster holds only who is on it now.
  const named = React.useMemo(
    () => [data.createdBy, ...data.replies.map((r) => r.createdBy)],
    [data.createdBy, data.replies],
  );
  const profiles = useUserProfiles(named);

  const [draft, setDraft] = React.useState<DraftState>(CLOSED_DRAFT);
  const [target, setTarget] = React.useState<DraftTarget>(null);
  // The reducer needs the draft as it stands at the moment of the event, and a
  // commit has to be written from the handler — a state updater must stay pure,
  // and under StrictMode it runs twice.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  const targetRef = React.useRef(target);
  targetRef.current = target;

  const frozen = locked === true;
  const open = draft.mode !== 'closed';

  const rightsFor = React.useCallback(
    (authorId: string): AnnotationRights => {
      // A locked node is frozen whole — content, name, existence — and these
      // controls are the only way a sticky's body and replies are ever
      // written, so the lock has to be answered here or it stops at the
      // border (§8.4).
      if (frozen) return NO_ANNOTATION_RIGHTS;
      // A read-only viewer is a viewer whatever else the role says: the
      // document refuses their writes, so offering the controls would put
      // buttons on screen that do nothing.
      return annotationRights({
        role: readOnly ? 'viewer' : myRole,
        viewerId,
        authorId,
      });
    },
    [frozen, readOnly, myRole, viewerId],
  );

  // A sticky names its authors and draws no faces (user 2026-09-14), so the
  // avatar the endpoint also returns goes unread.
  const nameOf = React.useCallback(
    (authorId: string): string => profiles.get(authorId)?.name ?? '',
    [profiles],
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

  const openDraft = React.useCallback(
    (at: DraftTarget, use: DraftState['use'], text: string): void => {
      targetRef.current = at;
      setTarget(at);
      apply({ type: 'open', use, text });
    },
    [apply],
  );

  // The reply box is the one entry point whose element stays on screen while
  // it is being used, so it opens its draft on whichever sign of use arrives
  // first — the caret landing in it, an IME session starting, or a character.
  //
  // Focus alone is not enough. After Enter the draft closes and the caret has
  // not moved, so no second focus event is coming: waiting for one left the
  // box dead — measured on a board, a second answer typed straight after the
  // first went nowhere, Post stayed disabled, and the way out was to click
  // elsewhere and back. Nor is the first character enough on its own: an IME
  // announces itself before it produces one, and a `compositionStart` dropped
  // on a closed draft takes the gate with it, so the Enter that picks a
  // candidate word posts the half-written reply instead.
  const intoReplyBox = React.useCallback(
    (action: DraftAction): void => {
      if (draftRef.current.mode === 'closed') openDraft(null, 'reply', '');
      apply(action);
    },
    [openDraft, apply],
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

  // While a box is open every other entry point goes away — the invariant the
  // reducer rests on. The one still standing is the box itself.
  const menusFor = React.useCallback(
    (rights: AnnotationRights, mine: boolean): AnnotationRights =>
      !open || mine
        ? rights
        : { ...rights, canEdit: false, canDelete: false },
    [open],
  );

  const editingBody =
    open && draft.use === 'edit' && target?.kind === 'body'
      ? draft.text
      : undefined;
  const composing = open && draft.use === 'reply' ? draft.text : '';
  // The reply box renders while nothing is open, and while the open box IS it.
  const canReply = rightsFor(data.createdBy).canPost && (!open || draft.use === 'reply');

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
        authorName={nameOf(data.createdBy)}
        rights={menusFor(rightsFor(data.createdBy), editingBody !== undefined)}
        editing={editingBody}
        testId='annotation-node-body'
        onEdit={() => openDraft({ kind: 'body' }, 'edit', data.content)}
        onDelete={() => {
          if (nodeId !== null) removeNode(projectId, spaceId, nodeId);
        }}
        onEditingChange={(text) => apply({ type: 'type', text })}
        onSave={() => apply({ type: 'save' })}
        onCancel={() => apply({ type: 'cancel' })}
      />

      {data.replies.length === 0 ? null : (
        // `nowheel` and `nodrag` hand the thread its own gestures back: the
        // wheel scrolls the replies instead of zooming the board, and a press
        // selects a line instead of flinging the note across it (measured at
        // 150px and 112px). Same pair, same reason, as the text node's body.
        <ScrollArea
          scrollbars='vertical'
          className='nowheel nodrag border-t border-note-border'
          viewportClassName={REPLIES_MAX_HEIGHT}
          data-testid='annotation-node-replies'
        >
          {data.replies.map((reply) => {
            const editing =
              open &&
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
                authorName={nameOf(reply.createdBy)}
                rights={menusFor(
                  rightsFor(reply.createdBy),
                  editing !== undefined,
                )}
                editing={editing}
                testId={`annotation-node-reply-${reply.id}`}
                onEdit={() =>
                  openDraft(
                    { kind: 'reply', id: reply.id },
                    'edit',
                    reply.content,
                  )
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

      {canReply ? (
        <div className='nodrag flex items-start gap-1.5 border-t border-note-border px-2 py-1.5'>
          <Textarea
            rows={1}
            value={composing}
            placeholder={t('canvas.annotation.replyPlaceholder')}
            className='min-h-0 resize-none text-xs'
            data-testid='annotation-node-reply-input'
            onFocus={() => intoReplyBox({ type: 'type', text: composing })}
            onChange={(e) => intoReplyBox({ type: 'type', text: e.target.value })}
            onCompositionStart={() =>
              intoReplyBox({ type: 'compositionStart' })
            }
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
