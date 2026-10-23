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
import { type FocusReturn, useFocusReturn } from '@web/lib/use-focus-return';
import { viewOf } from '@web/spaces/document/document-editor-view';
import { DocumentMediaPicker } from '@web/spaces/document/DocumentMediaPicker';
import { DocumentUploadPlaceholders } from '@web/spaces/document/DocumentUploadPlaceholders';
import { DocumentMediaViews } from '@web/spaces/document/DocumentMediaViews';
import { useDocumentBars } from '@web/spaces/document/document-bars';
import { BODY_GUTTER_START } from '@web/spaces/document/document-strip-alignment';
import { bodyPartMark, recomputeBodyFocus, releaseBodyFocus } from '@web/spaces/document/document-body-focus';
import { attachBodyScroller, BODY_BLANK } from '@web/spaces/document/document-body-press';
import type { DocumentUploader } from '@web/spaces/document/document-uploads';
import type { Landed } from '@web/spaces/document/document-proposal-landing';

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
  /** What takes files into this body; a body without one offers no media entries. */
  uploader?: DocumentUploader | null;
  /** Where an Agent proposal just landed, to show the reader (inner#1509). */
  landed?: Landed | null;
}

/** How long a block an Agent proposal landed stays marked. */
const LANDED_MARK_MS = 2000;

/** How long the mark takes to fade at the end of that time. */
const LANDED_FADE_MS = 300;

/** The token for how far the mark stands off the block's words on each side. */
const LANDED_MARK_GAP_VAR = '--space-2';

/** The fade at the end of the mark's time, as tw-animate-css reads it. */
const LANDED_MARK_FADE = {
  '--tw-animation-delay': `${String(LANDED_MARK_MS - LANDED_FADE_MS)}ms`,
  '--tw-animation-duration': `${String(LANDED_FADE_MS)}ms`,
} as React.CSSProperties;

/** The body's left gutter, where the strips stand. */
const GUTTER_START: React.CSSProperties = { paddingLeft: BODY_GUTTER_START };

/** Where the mark around a landed block is drawn, in the viewport's coordinates. */
interface LandedBox {
  top: number;
  left: number;
  width: number;
  height: number;
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
 * @param root0.uploader - What takes files into this body.
 * @param root0.landed - The block an Agent proposal just landed.
 * @returns The editor body, the comment panel beside it, the entry and the
 *   bubble bar.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  handle,
  readOnly = false,
  myRole = 'viewer',
  uploader = null,
  landed = null,
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
  // What it stands aside for is the bubble bar on screen, not the selection
  // behind it, which stays without being drawn once the body lets go of the
  // focus (inner#1127, `document-bars.ts`).
  const selectionHoldsText = useDocumentBars(handle.editor).bubbleBarUp;

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

  // Where an Agent proposal landed is shown once per landing: a hidden Space
  // runs its effects again when shown, and the reader may have scrolled away
  // since. A comment is shown the way the reader's own is, by reading its
  // thread, which opens the panel on its card; a block written is scrolled to
  // a third of the way down the viewport and outlined for a moment.
  const [landedBox, setLandedBox] = React.useState<LandedBox | null>(null);
  const shown = React.useRef<Landed | null>(null);
  React.useEffect(() => {
    if (landed === shown.current) return undefined;
    if (landed?.how === 'comment') {
      shown.current = landed;
      selectThreads(handle.editor, [landed.threadId]);
      return undefined;
    }
    const block = landed === null ? null : body.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(landed.blockId)}"]`);
    if (viewport === null || block === null || block === undefined) return undefined;
    shown.current = landed;
    // A regular block's own content leaves its indented children out. A
    // layout table is already its own content frame; descendants belong to
    // its cells and cannot stand in for the whole table (inner#1619).
    const at = (block.querySelector(':scope > .bn-block > .bn-block-content') ?? block).getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(viewport).getPropertyValue(LANDED_MARK_GAP_VAR)) || 0;
    const top = at.top - frame.top + viewport.scrollTop - gap;
    setLandedBox({
      top,
      left: at.left - frame.left + viewport.scrollLeft - gap,
      width: at.width + gap * 2,
      height: at.height + gap * 2,
    });
    viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 3), behavior: 'smooth' });
    const timer = window.setTimeout(() => setLandedBox(null), LANDED_MARK_MS);
    return () => {
      window.clearTimeout(timer);
      setLandedBox(null);
    };
  }, [landed, viewport, handle.editor]);

  // The scroller is where a press on blank space leaves the focus, and where
  // a press in the body is first read (inner#1127 A20). A Space hidden
  // lets go of the focus at once: its layers stay on the page, so nothing
  // waits for them to leave. Shown again, the body decides from where the
  // focus is.
  React.useEffect(() => {
    const view = handle.editor.prosemirrorView;
    if (viewport === null || view === null || readOnly) return;
    const detach = attachBodyScroller(view, viewport, handle.editor);
    recomputeBodyFocus(view);
    return () => {
      detach();
      releaseBodyFocus(view);
    };
  }, [handle, viewport, readOnly]);

  // Back on screen after a switch of Space, the caret goes back in if it was
  // here when the Space was hidden (inner#1235 A1): hiding takes focus out of
  // the editor, and the editor still holds the selection to put it back at.
  // Read off the DOM the editor is mounted in: an editor with no view throws
  // on any read of it.
  const focusReturn = React.useMemo<FocusReturn>(
    () => ({ hadFocus: false, returning: false }),
    // One per editor this body shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handle],
  );
  useFocusReturn(
    focusReturn,
    () => handle.surface.contains(document.activeElement),
    () => viewOf(handle.editor)?.focus(),
  );

  const viewOfEditor = React.useCallback(
    () => viewOf(handle.editor),
    [handle.editor],
  );

  const chrome = (
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
          The right gutter is where the whole-document entry stands, which
          sizes it (`--doc-body-gutter`); the left one is where a table's own
          strip stands, past its first column's (`BODY_GUTTER_START`). */}
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
          viewportClassName='relative outline-none'
        >
          {/* Both a flex item of the wrapper `index.css` grows, so the row
              takes that height, and a flex container, so the text column and
              the panel beside it each take it in turn. */}
          <div {...{ [BODY_BLANK]: '' }} className='flex flex-1'>
            {landedBox === null ? null : (
              <div
                data-testid='document-proposal-landed'
                aria-hidden='true'
                className='pointer-events-none absolute rounded-content-xs border border-content-link animate-out fade-out fill-mode-forwards'
                style={{ ...landedBox, ...LANDED_MARK_FADE }}
              />
            )}
            <div
              {...{ [BODY_BLANK]: '' }}
              className='flex min-w-0 flex-1 flex-col pr-[var(--doc-body-gutter)]'
              style={GUTTER_START}
            >
              <DocumentMenuEntry
                commentsOpen={railOpen}
                onOpenComments={openRail}
                unresolvedComments={rail.unresolved.length}
              />
              <div
                ref={body}
                data-testid='document-editor-content'
                // The body and the row handles that stand beside it: the
                // focus on a handle has not left the body.
                {...bodyPartMark(handle.editor)}
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
      {/* Every image, video and audio block, drawn into its node view's
          container from inside this tree (inner#1127). A viewer sees them
          too; their controls are hidden while the body is not editable. */}
      <DocumentMediaViews editor={handle.editor} />
      {/* What each upload in flight shows, in the body where it will land
          (inner#1127 A4). Kept for a body that turned read-only meanwhile:
          a failed file still has its placeholder to remove. */}
      {uploader !== null && (
        <DocumentUploadPlaceholders
          editor={handle.editor}
          uploader={uploader}
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

  // A viewer gets no media entries (A11); the menus that offer them are not
  // drawn for one either.
  return (
    <DocumentMediaPicker uploader={readOnly ? null : uploader} view={viewOfEditor}>
      {chrome}
    </DocumentMediaPicker>
  );
});
