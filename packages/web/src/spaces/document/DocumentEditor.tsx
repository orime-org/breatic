// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { BODY_ROW_CLASS, BODY_SCROLLER_CLASS } from '@web/spaces/document/document-body-scroller';
import {
  adoptDocumentEditor,
  type ShowableEditor,
} from '@web/spaces/document/document-editor-cache';
import { DocumentBlockControls } from '@web/spaces/document/DocumentBlockControls';
import { DocumentMenuEntry } from '@web/spaces/document/DocumentMenuEntry';
import { DocumentOutline } from '@web/spaces/document/DocumentOutline';
import { BODY_ROW_VARS } from '@web/spaces/document/document-columns';
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
import { DocumentAiDialog } from '@web/spaces/document/DocumentAiDialog';
import { DocumentMediaPicker } from '@web/spaces/document/DocumentMediaPicker';
import { DocumentMediaViews } from '@web/spaces/document/DocumentMediaViews';
import { useDocumentBars } from '@web/spaces/document/document-bars';
import { BODY_GUTTER_START } from '@web/spaces/document/document-strip-alignment';
import { bodyPartMark, recomputeBodyFocus, releaseBodyFocus } from '@web/spaces/document/document-body-focus';
import { attachBodyScroller, BODY_BLANK } from '@web/spaces/document/document-body-press';
import { viewOf } from '@web/spaces/document/document-editor-view';
import type { FileUploads } from '@web/spaces/document/document-uploads';
import { PendingUploadsContext, type PendingUploadsStore } from '@web/spaces/document/document-pending-uploads';
import { isCurrentProposalLocation, type ProposalLocation } from '@web/spaces/document/document-proposal-location';
import { sourceSpot } from '@web/spaces/document/document-proposal-landing';
import { revealInTable, tableViewportOf } from '@web/spaces/document/document-table-reveal';
import type { DocumentScope } from '@web/data/api/documents';
import { DocumentSnapshotNameDialog } from '@web/spaces/document/DocumentSnapshotNameDialog';
import { useDocumentVersions } from '@web/spaces/document/use-document-versions';

// The snapshot panel, its preview editor and the diff renderer load when the
// panel first opens (inner#1129 design §7.1).
const DocumentVersionArea = React.lazy(() => import('@web/spaces/document/DocumentVersionArea'));

interface DocumentEditorProps {
  /** The live editor and its surface, created and owned by the cache. */
  handle: ShowableEditor;
  /** True for a viewer. */
  readOnly?: boolean;
  /**
   * The user's role on the project.
   *
   * `readOnly` answers "may this person write at all", which the carriers
   * gate on. The draft card asks a second question — whether the right to
   * write was taken away while it was open (A22) — and that needs the role
   * itself. Defaults to the most restrictive reading, as `SpaceBodyProps`
   * does.
   */
  myRole?: ProjectRole;
  /** What admits files into this body; a body without it offers no media entries. */
  files?: FileUploads | null;
  /** What the body's pending media blocks read; null shows each as not finished. */
  pending?: PendingUploadsStore | null;
  /** Where an Agent proposal just landed, to show the user (inner#1509). */
  landed?: ProposalLocation | null;
  /** The document, for its snapshots; without it the snapshot commands are not drawn. */
  scope?: DocumentScope | null;
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
  location: ProposalLocation;
  style: { top: number; left: number; width: number; height: number };
}

/**
 * The box around every rectangle given.
 * @param rects - The rectangles, at least one.
 * @returns Their bounding box.
 */
function boxAround(rects: readonly DOMRect[]): DOMRect {
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The part of a box inside a frame.
 * @param box - The box.
 * @param frame - The frame.
 * @returns The box cut to the frame, empty when they do not meet.
 */
function cutTo(box: DOMRect, frame: DOMRect): DOMRect {
  const left = Math.max(box.left, frame.left);
  const top = Math.max(box.top, frame.top);
  return new DOMRect(left, top, Math.max(0, Math.min(box.right, frame.right) - left), Math.max(0, Math.min(box.bottom, frame.bottom) - top));
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
 * @param root0.myRole - The user's role on the project.
 * @param root0.files - What admits files into this body.
 * @param root0.pending - What the body's pending media blocks read.
 * @param root0.landed - The block an Agent proposal just landed.
 * @param root0.scope - The document, for its snapshots.
 * @returns The editor body, the comment panel beside it, the entry and the
 *   bubble bar.
 */
export const DocumentEditor = React.memo(function DocumentEditor({
  handle,
  readOnly = false,
  myRole = 'viewer',
  files = null,
  pending = null,
  landed = null,
  scope = null,
}: DocumentEditorProps): React.JSX.Element {
  const body = React.useRef<HTMLDivElement>(null);
  // The snapshot panel takes the body's place while open; the comment panel
  // and it are never up together (inner#1129 design §7.2).
  const versions = useDocumentVersions(handle.editor, scope);
  const { panelOpen, restoring, closePanel } = versions;
  // The one bit that says whether the panel is on screen, and the user is
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
    if (pressed.length === 0 || restoring) return;
    if (panelOpen) closePanel();
    setRailOpen(true);
  }, [pressed, panelOpen, restoring, closePanel]);
  // A comment being written is written in the panel, so the panel is up
  // whenever a draft is open, aimed or dropped (A1 · A2, design §9.6). The
  // entries dispatch the range and nothing else; this is the one place that
  // turns it into the panel being up, the same shape the press on a
  // highlight above takes.
  const draft = React.useSyncExternalStore(onDraftChange, () =>
    draftIn(handle.editor.prosemirrorState),
  );
  React.useEffect(() => {
    if (draft === null || restoring) return;
    if (panelOpen) closePanel();
    setRailOpen(true);
  }, [draft, panelOpen, restoring, closePanel]);
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
    // would put an empty card back on screen the next time the user opens
    // the panel, with nothing to explain where it came from (§9.4).
    const view = handle.editor.prosemirrorView;
    if (view !== null) {
      view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, null));
    }
    // And every reply box's unsent words. They are kept by the editor so a
    // Space tab switch does not take them; closing the panel is the user's
    // own doing, and it does (§9.6).
    clearReplies(handle.editor);
  }, [handle.editor]);
  const rail = useCommentRail(handle.editor);
  // ScrollArea owns this viewport; pass it to document surfaces so a table's
  // nested horizontal viewport cannot become their vertical scroll boundary.
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
  }, [handle]);

  // Where an Agent proposal landed is shown once per landing: a hidden Space
  // runs its effects again when shown, and the user may have scrolled away
  // since. Comment selection is issued once by the pickup's command outlet;
  // the rail consumes its current plugin state. A written block is scrolled
  // to a third of the way down the viewport and outlined for a moment. A
  // located proposal is shown the same way (inner#1646): the block it points
  // at, or only a comment's quoted words, found in the document as it is now.
  const [landedBox, setLandedBox] = React.useState<LandedBox | null>(null);
  const shown = React.useRef<ProposalLocation | null>(null);
  React.useEffect(() => {
    if (landed === shown.current) return undefined;
    // The body is unseen behind the snapshot panel: close it first, and this
    // runs again once the body is on screen to be measured. A restore being
    // written finishes first.
    if (landed !== null && (panelOpen || restoring)) {
      if (!restoring) closePanel();
      return undefined;
    }
    if (landed === null || landed.how === 'comment' || !isCurrentProposalLocation(landed, handle.editor)) return undefined;
    const spot = landed.how === 'source'
      ? sourceSpot(handle.editor.prosemirrorState.doc, landed)
      : { blockId: landed.blockId, ranges: null };
    const block = spot === null ? null : body.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(spot.blockId)}"]`);
    if (viewport === null || spot === null || block === null || block === undefined) return undefined;
    shown.current = landed;
    // A landed block's own content leaves its indented children out. A
    // layout table is already its own content frame; descendants belong to
    // its cells and cannot stand in for the whole table (inner#1619). A
    // located block takes its children with it, as a rewrite replaces them
    // and an insert goes after them (inner#1646).
    const own = block.querySelector<HTMLElement>(':scope > .bn-block > .bn-block-content') ?? block;
    const content = landed.how === 'source' ? block : own;
    const view = viewOf(handle.editor);
    const words = spot.ranges === null || view === null ? null : spot.ranges.map((r) => {
      const range = document.createRange();
      const from = view.domAtPos(r.from);
      const to = view.domAtPos(r.to);
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range;
    });
    const start = words?.[0]?.startContainer;
    const first = start instanceof HTMLElement ? start : start?.parentElement ?? null;
    const table = first === null ? null : tableViewportOf(first);
    const gap = parseFloat(getComputedStyle(viewport).getPropertyValue(LANDED_MARK_GAP_VAR)) || 0;
    /**
     * What the outline goes around: a landed block's own content, a located
     * block with the blocks nested under it from its first line down, or the
     * quoted words, cut to the part of their table's sideways frame on screen.
     * @returns Its rectangle on screen.
     */
    const outlined = (): DOMRect => {
      if (words === null || words.length === 0) {
        // A located block's box takes in the margin above its first line;
        // the outline starts at that line, so it stands off the words evenly.
        const at = content.getBoundingClientRect();
        const top = own.getBoundingClientRect().top;
        return new DOMRect(at.left, top, at.width, at.bottom - top);
      }
      const around = boxAround(words.map((w) => w.getBoundingClientRect()));
      return table === null ? around : cutTo(around, table.getBoundingClientRect());
    };
    // A table scrolls sideways in its own frame, which the body's scroll
    // does not move: bring the quoted words' cell in there first, the way a
    // comment's card does.
    if (first !== null) revealInTable(first);
    /**
     * Measures the layout after asynchronously committed table chrome changes it.
     * @returns The outline's current coordinates and dimensions in its viewport.
     */
    const measure = (): LandedBox['style'] => {
      const at = outlined();
      const frame = viewport.getBoundingClientRect();
      return {
        top: at.top - frame.top + viewport.scrollTop - gap,
        left: at.left - frame.left + viewport.scrollLeft - gap,
        width: at.width + gap * 2,
        height: at.height + gap * 2,
      };
    };
    const style = measure();
    setLandedBox({ location: landed, style });
    const sizes = new ResizeObserver(() => {
      const currentStyle = measure();
      setLandedBox((current) => current?.location === landed ? { location: landed, style: currentStyle } : current);
    });
    sizes.observe(content, { box: 'border-box' });
    sizes.observe(viewport, { box: 'border-box' });
    viewport.scrollTo({ top: Math.max(0, style.top - viewport.clientHeight / 3), behavior: 'smooth' });
    const timer = window.setTimeout(() => {
      sizes.disconnect();
      setLandedBox((current) => current?.location === landed ? null : current);
    }, LANDED_MARK_MS);
    return () => {
      sizes.disconnect();
      window.clearTimeout(timer);
      setLandedBox((current) => current?.location === landed ? null : current);
    };
  }, [landed, viewport, handle.editor, panelOpen, restoring, closePanel]);

  // The scroller is where a press on blank space leaves the focus, and where
  // a press in the body is first read (inner#1127 A20). A Space hidden
  // lets go of the focus at once: its layers stay on the page, so nothing
  // waits for them to leave. Shown again, the body decides from where the
  // focus is.
  React.useEffect(() => {
    const view = handle.editor.prosemirrorView;
    // With the snapshot panel open the scroller shows the preview, and a
    // Cmd/Ctrl+Z there must not undo the body nobody can see.
    if (viewport === null || view === null || readOnly || panelOpen) return;
    const detach = attachBodyScroller(view, viewport, handle.editor);
    recomputeBodyFocus(view);
    return () => {
      detach();
      releaseBodyFocus(view);
    };
  }, [handle, viewport, readOnly, panelOpen]);

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
          wheel anywhere in here moves both sides together. The heading outline
          stands left of it, outside the scroller, so it stays put while the
          body scrolls (inner#1149). */}
      <div className={`${BODY_ROW_CLASS} flex min-h-0 flex-1`} style={BODY_ROW_VARS}>
        {/* It lists the body's headings, and the body is behind the snapshot panel. */}
        {!panelOpen && (
          <DocumentOutline editor={handle.editor} viewport={viewport} readOnly={readOnly} commentsOpen={railOpen} />
        )}
        <ScrollArea
          viewportRef={setViewport}
          className={`${BODY_SCROLLER_CLASS} flex-1`}
          // `relative` makes the viewport the containing block for the link
          // panel's anchor, which is what lets that anchor scroll with the text
          // it points at. It also owns the media scroll/collision boundary.
          // The whole-document entry is `sticky` (it answers to the scroller), the
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
                style={{ ...landedBox.style, ...LANDED_MARK_FADE }}
              />
            )}
            {/* Behind the snapshot panel the body stays mounted and
                collaborating, out of sight and out of the flow (tiptap skill
                "Hide a container, do not unmount it"). */}
            <div
              {...{ [BODY_BLANK]: '' }}
              data-testid='document-body-column'
              className={panelOpen
                ? 'pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden'
                : 'flex min-w-0 flex-1 flex-col pr-[var(--doc-body-gutter)]'}
              style={GUTTER_START}
            >
              <DocumentMenuEntry
                commentsOpen={railOpen}
                onOpenComments={openRail}
                unresolvedComments={rail.unresolved.length}
                versionsOpen={panelOpen}
                onSaveSnapshot={scope === null || readOnly ? null : versions.requestSave}
                onRestoreSnapshot={scope === null ? null : versions.openPanel}
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
            {panelOpen && scope !== null && (
              <React.Suspense fallback={null}>
                <DocumentVersionArea
                  editor={handle.editor}
                  scope={scope}
                  versions={versions}
                  readOnly={readOnly}
                  viewport={viewport}
                  columnStyle={GUTTER_START}
                />
              </React.Suspense>
            )}
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
          too; editing controls follow permission while playback stays available. */}
      {pending === null ? (
        <DocumentMediaViews editor={handle.editor} readOnly={readOnly} viewport={viewport} />
      ) : (
        <PendingUploadsContext.Provider value={pending}>
          <DocumentMediaViews editor={handle.editor} readOnly={readOnly} viewport={viewport} />
        </PendingUploadsContext.Provider>
      )}
      {/* The strip beside the row under the pointer. A viewer gets none of it
          (A3): every command in the handle's menu writes to the document. */}
      {!readOnly && <DocumentBlockControls editor={handle.editor} />}
      <DocumentSnapshotNameDialog
        mode={versions.naming ? 'save' : null}
        currentName=''
        pending={versions.saving}
        onClose={versions.cancelSave}
        onSubmit={(name) => void versions.save(name)}
      />
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
    <DocumentMediaPicker files={readOnly ? null : files}>
      {/* The AI output dialog, reached from the bubble bar's AI menu
          (inner#1860). */}
      <DocumentAiDialog editor={handle.editor} viewport={viewport}>
        {chrome}
      </DocumentAiDialog>
    </DocumentMediaPicker>
  );
});
