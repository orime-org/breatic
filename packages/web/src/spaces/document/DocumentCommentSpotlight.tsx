// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The comment a press opens while the panel is shut (#18, A6 · A20).
 *
 * Pressing a highlight opens the comment it belongs to, and where that comment
 * appears depends on what is already on screen: the panel marks the card when
 * it is open, and this floats it beside the line when it is not. Google Docs
 * does the same thing — with its own panel open, a press in the body moves the
 * list rather than floating a second copy of the same card.
 *
 * ALL OF THEM, NOT THE FIRST. A press on two overlapping highlights names
 * both, and both are floated: that is how a reader picks, and picking is what
 * the design settles on rather than guessing the narrower one (§9).
 *
 * WHERE IT SITS comes from `panelReference`, the live rectangle the link
 * panel is anchored with — so it follows the words through a reflow, a peer's
 * edit and a scroll, and it is carried out of sight by the scroller's own
 * overflow when the words leave the viewport.
 */

import {
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

import { LINK_PANEL_SURFACE } from '@web/spaces/document/document-link-panel';
import { DocumentCommentCard } from '@web/spaces/document/DocumentCommentCard';
import { panelReference } from '@web/spaces/document/document-link-anchor';
import {
  onSelectedThreadsChange,
  selectThreads,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import {
  removeReply,
  removeThread,
  reopenThread,
  replyToThread,
  resolveThread,
} from '@web/spaces/document/document-comment-thread-actions';
import type { ToolEditor } from '@web/spaces/document/document-tool-button';
import {
  useCommentCards,
  useThreadRange,
} from '@web/spaces/document/use-comment-cards';
import { useCurrentUserStore } from '@web/stores/current-user';

/** The gap between the words and the card, as the link panel keeps it. */
const GAP_FROM_WORDS_PX = 6;

interface DocumentCommentSpotlightProps {
  /** The editor whose threads this draws. */
  editor: ToolEditor;
  /** This reader's role, which decides what the card offers. */
  myRole: ProjectRole;
}

/**
 * The floating card, or nothing while no highlight has been pressed.
 * @param root0 - See {@link DocumentCommentSpotlightProps}.
 * @param root0.editor - The editor whose threads this draws.
 * @param root0.myRole - This reader's role.
 * @returns The card, or null.
 */
export const DocumentCommentSpotlight = React.memo(
  function DocumentCommentSpotlight({
    editor,
    myRole,
  }: DocumentCommentSpotlightProps): React.JSX.Element | null {
    const selected = React.useSyncExternalStore(onSelectedThreadsChange, () =>
      selectedThreadsIn(editor.prosemirrorState),
    );
    const cards = useCommentCards(editor);
    const viewerId = useCurrentUserStore((state) => state.user?.id);

    // Unresolved only. A press opens what the reader pressed, and a resolved
    // thread's highlight is not painted (§9.2, S2) — so a card floating for
    // one would be answering a press on words that look like any others. It
    // is also what takes this card away when the reader settles the thread
    // from it: the thread leaves the group this reads. Settled threads are
    // read again through the panel's own filter (A9).
    const shown = React.useMemo(
      () => cards.unresolved.filter((card) => selected.includes(card.id)),
      [cards, selected],
    );

    const close = React.useCallback(() => {
      selectThreads(editor, []);
    }, [editor]);

    const handling = React.useMemo(
      () => ({
        myRole,
        viewerId,
        selected: true,
        /**
         * Adds a reply.
         * @param threadId - Which thread.
         * @param body - What it says.
         * @returns Whether a reply was written.
         */
        onReply: (threadId: string, body: string): Promise<boolean> =>
          replyToThread(editor, threadId, body),
        /**
         * Marks a thread settled.
         * @param threadId - Which thread.
         */
        onResolve: (threadId: string): void => {
          void resolveThread(editor, threadId);
        },
        /**
         * Brings a settled thread back.
         * @param threadId - Which thread.
         */
        onReopen: (threadId: string): void => {
          void reopenThread(editor, threadId);
        },
        /**
         * Withdraws a whole thread, and with it this card.
         * @param threadId - Which thread.
         */
        onDelete: (threadId: string): void => {
          void removeThread(editor, threadId);
        },
        /**
         * Withdraws one reply.
         * @param threadId - The thread it is on.
         * @param commentId - Which reply.
         */
        onDeleteReply: (threadId: string, commentId: string): void => {
          void removeReply(editor, threadId, commentId);
        },
      }),
      [editor, myRole, viewerId],
    );

    // The first thread's words are what the card is anchored to. A press on
    // two overlapping highlights lands inside both, so either answers the
    // question of where the reader is looking.
    const range = useThreadRange(editor, shown[0]?.id);
    const at = React.useMemo(
      () => (range === null ? null : panelReference(editor as never, range)),
      [editor, range],
    );

    const { refs, floatingStyles, context } = useFloating({
      open: shown.length > 0,
      onOpenChange: (next) => {
        if (!next) close();
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
      refs.setReference(at);
    }, [refs, at]);

    if (shown.length === 0 || at === null) return null;

    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          data-testid='doc-comment-spotlight'
          className={`${LINK_PANEL_SURFACE} z-50 flex w-72 flex-col gap-2`}
          {...getFloatingProps()}
        >
          {shown.map((card) => (
            <DocumentCommentCard key={card.id} card={card} {...handling} />
          ))}
        </div>
      </FloatingPortal>
    );
  },
);
