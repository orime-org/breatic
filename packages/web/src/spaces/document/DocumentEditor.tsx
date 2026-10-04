// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import {
  adoptDocumentEditor,
  type ShowableEditor,
} from '@web/spaces/document/document-editor-cache';
import { DocumentBlockControls } from '@web/spaces/document/DocumentBlockControls';
import { DocumentMenuEntry } from '@web/spaces/document/DocumentMenuEntry';
import { SelectionBubbleBar } from '@web/spaces/document/SelectionBubbleBar';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftIn,
  onDraftChange,
} from '@web/spaces/document/document-comment-draft-range';
import { clearReplies } from '@web/spaces/document/document-comment-unsent';
import type { ProjectRole } from '@breatic/shared';

import { DocumentCommentRail } from '@web/spaces/document/DocumentCommentRail';
import {
  hoverThread,
  onSelectedThreadsChange,
  selectThreads,
  selectedThreadsIn,
} from '@web/spaces/document/document-comment-selection';
import { useCommentRail } from '@web/spaces/document/use-comment-rail';
import { DocumentLinkToolbar } from '@web/spaces/document/DocumentLinkToolbar';
import { DocumentTableCellButton } from '@web/spaces/document/DocumentTableCellButton';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

interface DocumentEditorProps {
  /** The live editor and its surface, created and owned by the cache. */
  handle: ShowableEditor;
  /** True for a viewer. */
  readOnly?: boolean;
  /**
   * The reader's role on the project.
   *
   * `readOnly` answers "may this person write at all", which the carriers
   * gate on. The draft card asks a second question — whether the right to
   * write was taken away while it was open (A22) — and that needs the role
   * itself. Defaults to the most restrictive reading, as `SpaceBodyProps`
   * does.
   */
  myRole?: ProjectRole;
}

/**
 * The document editor's chrome: the scrolling body, the whole-document command
 * entry at its top right, and the selection bubble bar.
 *
 * Takes the editor rather than creating it, so the container owns the
 * collaborative wiring and this stays a presentation component.
 *
 * Which carrier a command belongs to follows what it acts on (design §3.0).
 * Three of them are here: the bubble bar for the selection, the entry for the
 * whole document, and the block handle's strip for the row under the pointer.
 * @param root0 - Editor chrome props.
 * @param root0.handle - The editor to render, with its surface.
 * @param root0.readOnly - True for a viewer.
 * @param root0.myRole - The reader's role on the project.
 * @returns The editor body, the comment panel beside it, the entry and the
 *   bubble bar.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  handle,
  readOnly = false,
  myRole = 'viewer',
}: DocumentEditorProps): React.JSX.Element {
  const body = React.useRef<HTMLDivElement>(null);
  // The one bit that says whether the panel is on screen, and the reader is
  // the only one who writes it: a comment arriving from a peer marks the `⋯`
  // button and moves nothing (design §5). Held here because the menu opens
  // the panel and the panel closes itself, so neither owns it.
  const [railOpen, setRailOpen] = React.useState(false);
  // Opening only: the menu row this is on stands aside while the panel is up,
  // and the panel closes itself.
  const openRail = React.useCallback(() => {
    setRailOpen(true);
  }, []);
  // A press on a highlight opens the panel, which is where a comment is read
  // (user 2026-09-22). The panel then brings that card into view and marks
  // it; nothing floats over the body.
  const pressed = React.useSyncExternalStore(onSelectedThreadsChange, () =>
    selectedThreadsIn(handle.editor.prosemirrorState),
  );
  React.useEffect(() => {
    if (pressed.length > 0) setRailOpen(true);
  }, [pressed]);
  // A comment being written is written in the panel, so the panel is up
  // whenever a draft is open, aimed or dropped (A1 · A2, design §9.6). The
  // entries dispatch the range and nothing else; this is the one place that
  // turns it into the panel being up, the same shape the press on a
  // highlight above takes.
  const draft = React.useSyncExternalStore(onDraftChange, () =>
    draftIn(handle.editor.prosemirrorState),
  );
  React.useEffect(() => {
    if (draft !== null) setRailOpen(true);
  }, [draft]);
  // Closing it ends both the reading and the pointer, because the panel is
  // the only thing that releases either and it is about to be gone. The
  // reading, left standing, makes the next press on the same highlight read
  // as "already open" — which answers nothing and leaves the panel shut. The
  // pointer, left standing, keeps a run of the body painted with nothing on
  // screen to explain it: the close button can be worked from the keyboard
  // while the pointer still rests on a card, so `onMouseLeave` never fires
  // (measured 2026-09-23, design §9.5).
  const closeRail = React.useCallback(() => {
    setRailOpen(false);
    selectThreads(handle.editor, []);
    hoverThread(handle.editor, null);
    // And the draft with them: the card it is written in lives in the panel,
    // so closing the panel is throwing it away. Left standing, the range
    // would put an empty card back on screen the next time the reader opens
    // the panel, with nothing to explain where it came from (§9.4).
    const view = handle.editor.prosemirrorView;
    if (view !== null) {
      view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
    }
    // And every reply box's unsent words. They are kept by the editor so a
    // Space tab switch does not take them; closing the panel is the reader's
    // own doing, and it does (§9.6).
    clearReplies(handle.editor);
  }, [handle.editor]);
  const rail = useCommentRail(handle.editor);
  // Held here because this is where the editor's DOM enters the scroller, and
  // the bar needs the element that now holds it. A child looking it up for
  // itself would look before this effect has run.
  const [viewport, setViewport] = React.useState<HTMLElement | null>(null);

  // The link toolbar stands aside while the selection holds anything: that is
  // what puts the bubble bar on screen, and the link panel only ever opens
  // over such a selection — so one reading covers both of the surfaces the
  // toolbar would otherwise sit on top of. The toolbar's own field leaves the
  // selection alone, so using it does not make it stand aside.
  const selectionHoldsText = useEditorSnapshot(
    handle.editor,
    (editor) => !editor.prosemirrorState.selection.empty,
  );

  // A hand-off, not a construction: the editor belongs to
  // `document-editor-cache` and outlives every one of these renders. What
  // moves is the surface it is mounted on; the cleanup deliberately tears
  // nothing down, because `unmount()` takes the collaboration binding and the
  // undo manager apart and a Space-tab switch would hand back an editor bound
  // to nothing. Evicting a closed tab is where that teardown belongs.
  React.useEffect(() => {
    const container = body.current;
    if (container === null) return;
    adoptDocumentEditor(handle, container);
    setViewport(
      container.closest<HTMLElement>('[data-radix-scroll-area-viewport]'),
    );
  }, [handle]);

  // Back on screen after a switch of Space, the caret goes back in if it was
  // here when the Space was hidden (inner#1235 A1): hiding takes focus out of
  // the editor, and the editor still holds the selection to put it back at.
  // Read in a layout cleanup, which runs before the Space is hidden; put back
  // a task later, once the Space is on screen again. Both read the DOM the
  // editor is mounted in: an editor with no view throws on any read of it.
  const hadFocus = React.useRef(false);
  React.useLayoutEffect(() => {
    const container = body.current;
    return () => {
      hadFocus.current = container?.contains(document.activeElement) ?? false;
    };
  }, [handle]);
  React.useEffect(() => {
    if (!hadFocus.current) return undefined;
    const id = window.setTimeout(() => {
      hadFocus.current = false;
      const editable = body.current?.querySelector('.ProseMirror');
      if (editable && !editable.contains(document.activeElement)) {
        handle.editor.prosemirrorView?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [handle]);

  return (
    // `isolate` keeps the z-values below local: the entry has to paint over
    // the body and the bubble bar over the entry, and neither of those two
    // relationships is anyone else's business. Without it both numbers would
    // be compared against every other layer on the page.
    <div className='relative isolate flex min-h-0 flex-1 flex-col'>
      {/* Overlay scrollbar (#1773): appears only while scrolling, takes no
          layout space. The side gutters live on the viewport — they are the
          margin OUTSIDE the page, and a click there is outside the document.
          The top and bottom breathing room does not: it belongs to the
          editable surface itself, or the strip of it below the last block
          answers no clicks (see `index.css`, `.doc-body-editor .ProseMirror`).
          The right gutter is also where the whole-document entry stands, which
          is what sizes both of them (`--doc-body-gutter`). */}
      {/* One scroller over both columns, so the scrollbar sits at the far
          right of the Space rather than between the text and the panel, and a
          wheel anywhere in here moves both sides together. */}
      <div className='flex min-h-0 flex-1'>
        <ScrollArea
          className={`${BODY_SCROLLER_CLASS} flex-1`}
          // `relative` makes the viewport the containing block for the link
          // panel's anchor, which is what lets that anchor scroll with the text
          // it points at. Nothing else inside is measured against it: the
          // whole-document entry is `sticky` (it answers to the scroller), the
          // caret that opens a document is `absolute` with no offsets and so
          // stays at its static position, and a remote caret's label is measured
          // against the caret itself.
          viewportClassName='relative'
        >
          {/* Both a flex item of the wrapper `index.css` grows, so the row
              takes that height, and a flex container, so the text column and
              the panel beside it each take it in turn. */}
          <div className='flex flex-1'>
            <div className='flex min-w-0 flex-1 flex-col px-[var(--doc-body-gutter)]'>
              <DocumentMenuEntry
                commentsOpen={railOpen}
                onOpenComments={openRail}
                unresolvedComments={rail.unresolved.length}
              />
              <div
                ref={body}
                data-testid='document-editor-content'
                className='doc-body-editor mx-auto max-w-3xl [&_.ProseMirror]:outline-none'
              />
            </div>
            {/* Beside the body rather than over it, so opening it narrows the
              text column and closing it widens the column again (A18). */}
            {railOpen && (
              <DocumentCommentRail
                editor={handle.editor}
                rail={rail}
                myRole={myRole}
                onClose={closeRail}
                scroller={viewport}
              />
            )}
          </div>
        </ScrollArea>
      </div>
      {/* A sibling here, inside the scroller's viewport at runtime: the bar
          portals itself there, so the viewport's own overflow is what takes it
          away once it has been carried out of sight. Over a select-all it is
          pinned to the pointer and stays put instead (E2). */}
      {viewport !== null && (
        <SelectionBubbleBar
          editor={handle.editor}
          viewport={viewport}
          readOnly={readOnly}
        />
      )}
      {/* The strip beside the row under the pointer. A viewer gets none of it
          (A3): every command in the handle's menu writes to the document. */}
      {!readOnly && <DocumentBlockControls editor={handle.editor} />}
      {/* The button on the cell the caret is in; a viewer gets none of it
          either (inner#1126 A18). */}
      {viewport !== null && !readOnly && (
        <DocumentTableCellButton editor={handle.editor} viewport={viewport} />
      )}
      {/* The toolbar over a link the pointer hovers or the caret sits in. It
          owns its own timing, position and state; what it takes from here is
          where to draw and when to stand aside.

          A viewer never gets it (E1): both its controls write to the
          document, and ProseMirror does not gate a dispatch on whether the
          editor is editable. */}
      {viewport !== null && !readOnly && (
        <DocumentLinkToolbar
          editor={handle.editor}
          viewport={viewport}
          yielding={selectionHoldsText}
        />
      )}
    </div>
  );
});
