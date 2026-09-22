// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The box a reader writes a comment in (#18, A1 · A2 · A21 · A22).
 *
 * It is on screen exactly while a draft is open, and a draft is open exactly
 * while the plugin holds a range — so nothing here decides when to appear,
 * and both entries get the same box without either of them knowing about it.
 *
 * WHAT IT OWNS is the words, through `reduceDraft` — the same reducer the
 * canvas annotations use (#1881), unchanged. Its `drop` action carries the two
 * closings that are not the reader's doing, and both owe them an account: the
 * text the comment was aimed at is gone (A21), or their right to write here
 * was taken away mid-draft (A22). The notice stands until they dismiss it.
 *
 * WHERE IT SITS comes from `panelReference`, the live rectangle the link
 * controls measure against: a DOM Range over the target, rebuilt per
 * measurement, which follows the words through a reflow, a peer's writing and
 * the focus leaving. The demo puts the box beside the line rather than at the
 * far right of the screen.
 *
 * THE QUOTE shows the words being commented on and draws them one way for
 * both entries. Design §6.1 settles that a whole-block comment and a text one
 * are identical past the range, so nothing distinguishes them to draw.
 */

import {
  FloatingFocusManager,
  FloatingPortal,
  autoUpdate,
  flip,
  inline,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react';
import * as React from 'react';

import type { ProjectRole } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { useTranslation } from '@web/i18n/use-translation';
import { canPostAnnotations } from '@web/spaces/canvas/annotation/rights';
import {
  CLOSED_DRAFT,
  reduceDraft,
  type DraftState,
} from '@web/stores/annotation-draft';
import { panelReference } from '@web/spaces/document/document-link-anchor';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftRangeIn,
  onDraftRangeChange,
} from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';
import { LINK_PANEL_SURFACE } from '@web/spaces/document/document-link-panel';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';

/** How far off the words the box sits, the gap the link panel uses. */
const GAP_FROM_WORDS_PX = 8;

interface ComposerProps {
  /** The editor the comment lands in. */
  editor: ToolEditor;
  /**
   * The reader's role on the project, watched so losing the right to write
   * closes an open box (A22).
   *
   * Named as `SpaceBodyProps` names it. A prop called `role` on a JSX element
   * is read as the ARIA attribute, by the linter and by anyone reading it.
   */
  myRole: ProjectRole;
}

/**
 * The box a reader writes a comment in.
 * @param root0 - The editor and the reader's role.
 * @param root0.editor - The editor the comment lands in.
 * @param root0.myRole - The reader's role on the project.
 * @returns The box while a draft is open, nothing otherwise.
 */
export function DocumentCommentComposer({
  editor,
  myRole,
}: ComposerProps): React.JSX.Element | null {
  const t = useTranslation();
  const [draft, setDraft] = React.useState<DraftState>(CLOSED_DRAFT);

  // Subscribed to the plugin rather than to the editor's own events: opening
  // a draft dispatches nothing but the meta, so neither `onChange` nor
  // `onSelectionChange` fires (see `onDraftRangeChange`).
  const aimedAt = React.useSyncExternalStore(
    onDraftRangeChange,
    () => draftRangeIn(editor.prosemirrorState),
  );

  const quote =
    aimedAt === null
      ? ''
      : editor.prosemirrorState.doc.textBetween(aimedAt.from, aimedAt.to);

  const mayWrite = canPostAnnotations(myRole);

  /**
   * Closes the draft's range, which is what takes the box off screen.
   * @param editorToClose - The editor holding the draft.
   */
  const clearRange = React.useCallback((editorToClose: ToolEditor): void => {
    const view = editorToClose.prosemirrorView;
    if (view === null) return;
    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
  }, []);

  // The range opening is what opens the draft: the entries dispatch it, and
  // this is where that becomes a box with words in it.
  React.useEffect(() => {
    if (aimedAt === null) return;
    setDraft((current) =>
      current.mode === 'closed'
        ? reduceDraft(current, { type: 'open', use: 'annotation', text: '' })
        : current,
    );
  }, [aimedAt]);

  // The two closings that are not the reader's doing. Each drops the draft
  // with its reason, and the reason is what the notice reads from.
  React.useEffect(() => {
    if (aimedAt !== null) return;
    setDraft((current) =>
      current.mode === 'typing'
        ? reduceDraft(current, { type: 'drop', why: 'targetGone' })
        : current,
    );
  }, [aimedAt]);

  React.useEffect(() => {
    if (mayWrite) return;
    setDraft((current) =>
      current.mode === 'typing'
        ? reduceDraft(current, { type: 'drop', why: 'cannotWrite' })
        : current,
    );
    clearRange(editor);
  }, [mayWrite, editor, clearRange]);

  /**
   * Throws the words away, which the demo's own table asks of Escape.
   */
  const cancel = React.useCallback((): void => {
    setDraft((current) => reduceDraft(current, { type: 'escape' }));
    clearRange(editor);
  }, [editor, clearRange]);

  const reference = React.useMemo(
    () => (aimedAt === null ? null : panelReference(editor, aimedAt)),
    [editor, aimedAt],
  );

  const { refs, floatingStyles, context } = useFloating({
    open: aimedAt !== null || draft.dropped !== undefined,
    // Escape and a press outside both close the box and keep nothing, which
    // is what the demo's own table asks of them. Handled by the library so
    // there is one answer for both gestures rather than a key listener of
    // ours beside a press listener of somebody else's.
    onOpenChange: (next) => {
      if (!next) cancel();
    },
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(GAP_FROM_WORDS_PX),
      inline(),
      flip({ padding: GAP_FROM_WORDS_PX }),
      shift({ padding: GAP_FROM_WORDS_PX }),
    ],
  });
  const { getFloatingProps } = useInteractions([useDismiss(context)]);

  React.useEffect(() => {
    refs.setReference(reference);
  }, [refs, reference]);

  /**
   * Posts what the reader wrote, then closes the box.
   */
  const post = React.useCallback((): void => {
    const saved = reduceDraft(draft, { type: 'save' });
    if (saved.commit === undefined) {
      // Blank words are not worth writing, and the reducer says so by handing
      // back a draft with no `commit` — the box stays open.
      setDraft(saved);
      return;
    }
    setDraft(saved);
    void postComment(editor, saved.commit).finally(() => {
      // The range is what says a draft is open, so clearing it is what closes
      // the box — and it has to happen whether the post landed or threw.
      clearRange(editor);
    });
  }, [draft, editor, clearRange]);

  if (draft.dropped !== undefined) {
    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          data-testid='doc-comment-composer'
          className={`${LINK_PANEL_SURFACE} z-50 w-64`}
        >
          <p
            data-testid='doc-comment-dropped'
            className='px-1 py-0.5 text-xs text-muted-foreground'
          >
            {t(
              draft.dropped === 'targetGone'
                ? 'spaces.document.comment.targetGone'
                : 'spaces.document.comment.cannotWrite',
            )}
          </p>
        </div>
      </FloatingPortal>
    );
  }

  if (aimedAt === null) return null;

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false} initialFocus={0}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          role='dialog'
          data-testid='doc-comment-composer'
          className={`${LINK_PANEL_SURFACE} z-50 w-64`}
          {...getFloatingProps()}
        >
          <p
            data-testid='doc-comment-quote'
            className='mb-2 truncate border-l border-border pl-1.5 text-xs text-muted-foreground'
          >
            {quote}
          </p>
          <div className='flex gap-1.5'>
            <Input
              data-testid='doc-comment-input'
              value={draft.text}
              placeholder={t('spaces.document.comment.placeholder')}
              onChange={(event) => {
                setDraft((current) =>
                  reduceDraft(current, {
                    type: 'type',
                    text: event.target.value,
                  }),
                );
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  post();
                }
              }}
            />
            <Button
              data-testid='doc-comment-post'
              variant='outline'
              onClick={post}
            >
              {t('spaces.document.comment.post')}
            </Button>
          </div>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
