// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A collaboration sticky: what somebody said about this part of the canvas,
 * the replies under it, and a box to answer in.
 *
 * Not a content node — it holds no payload and generates nothing, so it draws
 * no handles: a sticky is about the canvas, never an input to it (#1881 §8.5).
 * With no handle there is nothing for xyflow to start or land a connection on,
 * and that is the whole of it: `connection-rules.ts` lists no annotation, and
 * a target absent from its whitelist accepts any source.
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
import { X } from 'lucide-react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Textarea } from '@web/components/ui/textarea';
import {
  addReply,
  editAnnotationBody,
  editReply,
  removeReply,
} from '@web/data/yjs/canvas-space';
import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { useTranslation } from '@web/i18n/use-translation';
import { useAutosizeTextarea } from '@web/lib/use-autosize-textarea';
import {
  pressLandedOnTheBox,
  usePressKeepsFocus,
} from '@web/lib/use-press-keeps-focus';
import { cn } from '@web/lib/utils';
import { AnnotationEntry } from '@web/spaces/canvas/annotation/AnnotationEntry';
import { useAnnotationNames } from '@web/spaces/canvas/annotation/names';
import {
  NOTE_BOX_MAX_HEIGHT,
  NOTE_REGION_MAX_HEIGHT,
} from '@web/spaces/canvas/annotation/caps';
import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftAction,
  type DraftState,
  type DraftTarget,
} from '@web/stores/annotation-draft';
import { useCanvasStore, type OpenAnnotationDraft } from '@web/stores/canvas';
import {
  annotationRights,
  canPostAnnotations,
  type AnnotationRights,
} from '@web/spaces/canvas/annotation/rights';
import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * Whether an entry is the one the open box belongs to.
 * @param at - The entry asking.
 * @param target - What the open draft is written against, if anything.
 * @returns True when they name the same entry. A new annotation or a new reply
 *   has no target, so it names none of them.
 */
function isTarget(at: DraftTarget, target: DraftTarget): boolean {
  if (at === null || target === null) return false;
  if (at.kind === 'body') return target.kind === 'body';
  return target.kind === 'reply' && target.id === at.id;
}

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
  const { deleteNode } = useCanvasActions();
  const viewerId = useCurrentUserStore((s) => s.user?.id);

  // Names come from the board, which asks for everybody on it in one request
  // rather than one per sticky. Resolved from their accounts and not from the
  // project roster: a note keeps its author's name after they leave the
  // project (A11), and the roster holds only who is on it now.
  const profiles = useAnnotationNames();

  // The box lives in the canvas store, keyed by this node, rather than in this
  // component: the canvas culls offscreen nodes and a draft held here went out
  // with the DOM. Reading it back is a subscription to this one key, so a
  // keystroke on one sticky redraws that sticky and nothing else.
  const open_ = useCanvasStore((s) =>
    nodeId === null ? undefined : s.annotationDrafts[nodeId],
  );
  const setAnnotationDraft = useCanvasStore((s) => s.setAnnotationDraft);
  const draft = open_?.draft ?? CLOSED_DRAFT;
  const target = open_?.target ?? null;

  const frozen = locked === true;
  const open = draft.mode !== 'closed';
  // A press on the reply row's padding, its gap or its Post button leaves the
  // caret in the box: a blur there discards a reply nobody has posted yet.
  const [replyRow, setReplyRow] = React.useState<HTMLDivElement | null>(null);
  usePressKeepsFocus(replyRow, pressLandedOnTheBox);
  // Always exactly as tall as what is written, so the box itself never
  // scrolls and never draws the browser's scrollbar; the row's own
  // `ScrollArea` owns the cap and the bar.
  const replyBox = React.useRef<HTMLTextAreaElement>(null);
  const composing = open && draft.use === 'reply' ? draft.text : '';
  useAutosizeTextarea(replyBox, composing);

  // A locked node is frozen whole — content, name, existence (§8.4) — and a
  // read-only viewer is a viewer whatever else the role says. Both mean "no
  // writes here", which is what a viewer means, so they are one coercion
  // rather than a branch each: these controls are the only way a sticky's body
  // and its replies are ever written.
  const role: ProjectRole = frozen || readOnly ? 'viewer' : myRole;
  const rightsFor = React.useCallback(
    (authorId: string): AnnotationRights =>
      annotationRights({ role, viewerId, authorId }),
    [role, viewerId],
  );

  // A sticky names its authors and draws no faces (user 2026-09-14), so the
  // avatar the endpoint also returns goes unread.
  const nameOf = React.useCallback(
    (authorId: string): string => profiles.get(authorId)?.name ?? '',
    [profiles],
  );

  const write = React.useCallback(
    (at: DraftTarget, use: DraftState['use'], text: string): boolean => {
      if (nodeId === null) return false;
      const now = Date.now();
      if (use === 'reply') {
        return addReply(projectId, spaceId, nodeId, {
          id: crypto.randomUUID(),
          content: text,
          createdBy: viewerId ?? '',
          createdAt: now,
        });
      }
      if (at?.kind === 'reply') {
        return editReply(projectId, spaceId, nodeId, at.id, text, now);
      }
      return editAnnotationBody(projectId, spaceId, nodeId, text, now);
    },
    [nodeId, projectId, spaceId, viewerId],
  );

  /**
   * What this sticky has open right now, straight from the store.
   *
   * The reducer needs the draft as it stood at the moment of the event, and a
   * commit has to be written from the handler — a state updater must stay
   * pure, and under StrictMode it runs twice. Reading the store rather than
   * the render's own copy answers both without a ref to keep in step.
   * @returns The open box, or a closed draft with no target.
   */
  const readDraft = React.useCallback((): OpenAnnotationDraft => {
    const held =
      nodeId === null
        ? undefined
        : useCanvasStore.getState().annotationDrafts[nodeId];
    return held ?? { draft: CLOSED_DRAFT, target: null };
  }, [nodeId]);

  const apply = React.useCallback(
    (action: DraftAction): void => {
      if (nodeId === null) return;
      const held = readDraft();
      const next = reduceDraft(held.draft, action);
      if (next === held.draft) return;
      // The write goes first, because whether it landed decides what the store
      // is told. The entry can go between the last render and this keystroke,
      // and by the time the effect below sees that the box is already closed —
      // the writer's answer is the only account of where the words went.
      const settled: DraftState =
        next.commit === undefined || write(held.target, next.use, next.commit)
          ? next
          : { ...next, dropped: 'targetGone' };
      // A closed draft is forgotten, except while it carries that notice.
      setAnnotationDraft(
        nodeId,
        settled.mode === 'closed' && settled.dropped === undefined
          ? null
          : {
            draft: settled,
            target: settled.mode === 'closed' ? null : held.target,
          },
      );
    },
    [nodeId, readDraft, setAnnotationDraft, write],
  );

  const openDraft = React.useCallback(
    (at: DraftTarget, use: DraftState['use'], text: string): void => {
      if (nodeId === null) return;
      const next = reduceDraft(readDraft().draft, { type: 'open', use, text });
      setAnnotationDraft(nodeId, { draft: next, target: at });
    },
    [nodeId, readDraft, setAnnotationDraft],
  );

  // The reply box is the one entry point whose element stays on screen while
  // it is being used, so it opens its draft on the first character rather than
  // on a press somewhere else.
  const intoReplyBox = React.useCallback(
    (action: DraftAction): void => {
      if (readDraft().draft.mode === 'closed') openDraft(null, 'reply', '');
      apply(action);
    },
    [readDraft, openDraft, apply],
  );

  // A draft open against something a collaborator just deleted has nowhere to
  // land. The reducer closes it and marks why, so the sticky can say so rather
  // than leaving the words in a box that writes nowhere.
  React.useEffect(() => {
    const at = readDraft().target;
    if (at?.kind !== 'reply') return;
    if (data.replies.some((reply) => reply.id === at.id)) return;
    apply({ type: 'drop', why: 'targetGone' });
  }, [data.replies, readDraft, apply]);

  // What an entry may still offer while a box is open somewhere on the sticky.
  //
  // Edit goes everywhere — that is the invariant the reducer rests on (§6.2
  // reads "an entry point does not render while a box is open") and it refuses
  // a second open on a live draft, so an Edit offered anywhere is a command
  // that cannot act. Delete goes on ONE entry: the one the box belongs to,
  // where the "this was deleted" notice would report the reader's own action
  // back to them as something that had befallen them. Everywhere else Delete
  // stands — it opens no box, and taken off the whole sticky it meant one
  // character in the reply box left nothing on the note deletable.
  const offeredWhileBoxOpen = React.useCallback(
    (rights: AnnotationRights, at: DraftTarget): AnnotationRights =>
      open
        ? { ...rights, canEdit: false, canDelete: rights.canDelete && !isTarget(at, target) }
        : rights,
    [open, target],
  );

  // Whether this person may add words at all: their role, and the lock. Who
  // wrote the note has nothing to do with it.
  const mayWrite = canPostAnnotations(role);

  // The right to write can be taken away while a box is open — somebody locks
  // the node, or an owner demotes the writer to viewer. The lock used to reach
  // the entry points and stop: the menu and the reply box went, the open edit
  // box and its Save stayed, and pressing Save wrote into the frozen node.
  // Both halves are needed. The gate on `editingBody` below takes the box off
  // the same render, and this drops the draft behind it — a box removed while
  // its draft stayed open would leave the sticky with no entry points at all
  // and no way back. It says so rather than closing quietly: the words were
  // taken away by somebody else, same as a deleted entry, and the writer is
  // owed the same account.
  React.useEffect(() => {
    if (!mayWrite) apply({ type: 'drop', why: 'cannotWrite' });
  }, [mayWrite, apply]);

  const editingBody =
    mayWrite && open && draft.use === 'edit' && target?.kind === 'body'
      ? draft.text
      : undefined;
  // The reply box renders while nothing is open, and while the open box IS it.
  const canReply = mayWrite && (!open || draft.use === 'reply');

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
        rights={offeredWhileBoxOpen(rightsFor(data.createdBy), { kind: 'body' })}
        editing={editingBody}
        ownScroller
        testId='annotation-node-body'
        onEdit={() => openDraft({ kind: 'body' }, 'edit', data.content)}
        // Through the canvas, which owns the guard: a lock on the GROUP this
        // sticky belongs to freezes its members, and a member is handed only
        // its own `data.locked`. Writing straight to the document from here
        // gave the note two controls with opposite answers.
        onDelete={() => {
          if (nodeId !== null) deleteNode(nodeId);
        }}
        onDraft={apply}
      />

      {data.replies.length === 0 ? null : (
        // `nowheel` and `nodrag` hand the thread its own gestures back: the
        // wheel scrolls the replies instead of zooming the board, and a press
        // selects a line instead of flinging the note across it (measured at
        // 150px and 112px). Same pair, same reason, as the text node's body.
        <ScrollArea
          scrollbars='vertical'
          className='nowheel nodrag border-t border-note-border'
          viewportClassName={NOTE_REGION_MAX_HEIGHT}
          data-testid='annotation-node-replies'
        >
          {data.replies.map((reply) => {
            const editing =
              mayWrite &&
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
                rights={offeredWhileBoxOpen(rightsFor(reply.createdBy), {
                  kind: 'reply',
                  id: reply.id,
                })}
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
                onDraft={apply}
              />
            );
          })}
        </ScrollArea>
      )}

      {draft.dropped === undefined ? null : (
        // Where the words went, when it was not this person's doing. It needs
        // a way out of its own: the box is closed, so none of the draft's
        // events reach the reducer any more, and left standing the line sits
        // on the sticky for as long as the page does.
        <div
          className='flex items-start gap-1 border-t border-note-border px-2 py-1.5'
          data-testid='annotation-node-drop-notice'
        >
          <p className='min-w-0 flex-1 text-2xs text-muted-foreground'>
            {t(
              draft.dropped === 'targetGone'
                ? 'canvas.annotation.targetGone'
                : 'canvas.annotation.cannotWrite',
            )}
          </p>
          <Button
            variant='ghost'
            size='compact'
            className='w-6 shrink-0 px-0'
            data-testid='annotation-node-drop-dismiss'
            onClick={() => apply({ type: 'dismiss' })}
          >
            <X className='h-3 w-3' />
          </Button>
        </div>
      )}

      {canReply ? (
        <div
          ref={setReplyRow}
          // The box takes the whole width and the post button sits under it
          // (user 2026-09-14, design §8.1.1). Beside the box it spent a third
          // of a 200px note's width and left a 34px box next to a 24px
          // button; the rewrite box above already stacks its own buttons, and
          // so does the chat composer this is shaped like.
          className='nodrag flex flex-col gap-1.5 border-t border-note-border px-2 py-1.5'
          // The row loses the reply, not the box. Cancel and Post sit after
          // the box in the tab order, so a blur on the box alone threw the
          // words away on the first Tab and took both buttons with them —
          // keyboard-only readers could never reach either. Focus moving
          // WITHIN the row is the reader still working on this reply; focus
          // leaving it (or going nowhere, `relatedTarget` null) is not.
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget)) return;
            apply({ type: 'blur' });
          }}
        >
          <ScrollArea
            scrollbars='vertical'
            className='nowheel min-w-0'
            viewportClassName={NOTE_BOX_MAX_HEIGHT}
            data-testid='annotation-node-reply-scroller'
          >
            <Textarea
              ref={replyBox}
              rows={1}
              value={composing}
              placeholder={t('canvas.annotation.replyPlaceholder')}
              className='min-h-0 resize-none overflow-hidden text-xs'
              data-testid='annotation-node-reply-input'
              onChange={(e) => intoReplyBox({ type: 'type', text: e.target.value })}
              onKeyDown={(e) => {
                // A keystroke an IME is composing with belongs to the IME.
                if (e.nativeEvent.isComposing) return;
                // Shift+Enter is a line inside the reply; Enter posts it.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  apply({ type: 'save' });
                  return;
                }
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  apply({ type: 'escape' });
                }
              }}
            />
          </ScrollArea>
          {composing.trim().length === 0 ? null : (
            // Drawn only once there is something to post. Always there, it was
            // a permanently greyed control holding width on a note that has
            // 182px of it, and the empty note no longer matches the one shape
            // the reply row was confirmed in: a single full-width box.
            // Cancel and post, the pair the rewrite box above offers. The
            // row's own press guard keeps the caret in the box, so a press
            // here never blurs and neither has to hold focus itself; both
            // act on the click rather than the press down, so sliding off
            // one of them still calls it off.
            <div className='flex justify-end gap-1'>
              <Button
                variant='ghost'
                size='sm'
                className='h-6 text-2xs'
                data-testid='annotation-node-reply-cancel'
                onClick={() => apply({ type: 'cancel' })}
              >
                {t('canvas.annotation.cancel')}
              </Button>
              <Button
                size='sm'
                className='h-6 text-2xs'
                data-testid='annotation-node-reply-post'
                onClick={() => apply({ type: 'save' })}
              >
                {t('canvas.annotation.save')}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </NodeShell>
  );
});
