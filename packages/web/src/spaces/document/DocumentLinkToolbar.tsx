// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The toolbar over a link the pointer is hovering or the caret is inside.
 *
 * It owns what it shows. The two routes in are its own — a delegated
 * `mousemove` on the editor for the pointer, the document's own change events
 * for the caret — and the link it is about is held by a Yjs handle, the same
 * way the panel holds one.
 *
 * What it holds is a POSITION, never an element. An anchor stops representing
 * its link the moment anything writes: `applyLink` builds a new mark, and a
 * mark view whose mark is not `eq` is destroyed and rebuilt
 * (`prosemirror-view/src/viewdesc.ts:637`). A link with a style inside it is
 * drawn as several sibling anchors, none of which is the link. Five rounds of
 * review found nothing but consequences of holding one. Nobody in the field
 * holds one either — ProseMirror's own example, Milkdown, Lexical, tiptap and
 * CKEditor all resolve coordinates to a position and measure from there, and
 * CKEditor writes the reason beside its own callback (`linkui.ts:1287-1290`):
 * a cached DOM range is very fragile.
 *
 * So `useHover` cannot be used: every listener it registers sits inside a check
 * for a real DOM reference (`floating-ui.react.mjs:887`), and
 * `refs.setPositionReference` never writes one — measured, an anchor given only
 * a position reference raises nothing at all
 * (`engineering/demo/2026-09-14-floating-ui-references.probe.tsx`). Its two
 * jobs are done here instead: the delay by the two timers below, and
 * `safePolygon`'s job of surviving the travel from the link to the toolbar by
 * the close delay plus the toolbar's own record of the pointer being on it.
 * Milkdown does the same with the same two listeners and one flag
 * (`preview-view.ts:82-92`).
 *
 * With no DOM reference, a press on the link counts as a press OUTSIDE, which
 * is what should happen: the press opens the address in a new tab, and the
 * toolbar goes.
 *
 * It writes through `document-link.ts` rather than the extension's own
 * `editLink`, which adds the mark with no check at all, so a `javascript:`
 * address typed in here would reach every peer.
 */

import * as React from 'react';
import {
  useFloating,
  useDismiss,
  useInteractions,
  FloatingPortal,
  autoUpdate,
  offset,
  inline,
  flip,
  shift,
} from '@floating-ui/react';

import { DocumentLinkRead } from '@web/spaces/document/DocumentLinkRead';
import { DocumentLinkForm } from '@web/spaces/document/DocumentLinkForm';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import { LINK_PANEL_SURFACE } from '@web/spaces/document/document-link-panel';
import {
  panelReference,
  underPointer,
  type PointerPoint,
} from '@web/spaces/document/document-link-anchor';
import { linkAtCaret } from '@web/spaces/document/document-link-at';
import {
  trackLink,
  resolveTrackedLink,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import {
  applyLink,
  removeLink,
  linksAtPoint,
  type LinkAt,
  type LinkRange,
} from '@web/spaces/document/document-link';
import {
  viewOf,
  domElementOf,
  type ViewedEditor,
} from '@web/spaces/document/document-editor-view';
import {
  HOVER_OPEN_DELAY_MS,
  HOVER_CLOSE_DELAY_MS,
} from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

/** Which of the toolbar's two faces is showing. */
type ToolbarFace = 'read' | 'form';

/** The link the toolbar is about, and how it was reached. */
interface HeldLink {
  /** The handle that follows the link through a co-editor's writing. */
  readonly tracked: TrackedLink | null;
  /** Where it is now. */
  readonly range: LinkRange;
  /** The address, as stored on it. */
  readonly href: string | null;
  /** Which route raised the toolbar. */
  readonly reachedBy: 'pointer' | 'caret';
}

/**
 * The gap between the toolbar and the link it points at.
 *
 * The panel's own rung to start from; measured on a real page at the end, as
 * the gap is counted from the edge the reader sees rather than from the
 * element the library measures.
 */
const LINK_TOOLBAR_GAP = 8;

/**
 * Whether two ranges name the same run of text.
 * @param one - A range, or nothing.
 * @param other - The range to compare it with, or nothing.
 * @returns True when both are ranges and they are the same one.
 * @throws {never}
 */
function sameSpan(one: LinkRange | null, other: LinkRange | null): boolean {
  if (one === null || other === null) return false;
  return one.from === other.from && one.to === other.to;
}

/**
 * The toolbar over one link.
 * @param props - The editor, where to draw, and whether to stand aside.
 * @param props.editor - The editor holding the links.
 * @param props.viewport - The scroller the toolbar is drawn inside.
 * @param props.yielding - True while another control owns the same text.
 * @returns The toolbar, or nothing while it holds no link.
 */
export function DocumentLinkToolbar({
  editor,
  viewport,
  yielding,
}: {
  editor: ViewedEditor;
  viewport: HTMLElement;
  yielding: boolean;
}): React.JSX.Element | null {
  const [held, setHeld] = React.useState<HeldLink | null>(null);
  const [open, setOpen] = React.useState(false);
  const [face, setFace] = React.useState<ToolbarFace>('read');
  const inputRef = React.useRef<HTMLInputElement>(null);
  /**
   * The toolbar's own element, for asking whether it holds the focus.
   *
   * The library keeps the same element in `refs.floating`, which is written
   * by the same callback; this one exists because the questions asked of it
   * are asked by callbacks defined above `useFloating`, which is what hands
   * `refs` out.
   */
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);
  /** The hold as the event handlers see it, in step with the state. */
  const heldRef = React.useRef<HeldLink | null>(null);
  /** The face as the timers see it; they run long after they were set. */
  const faceRef = React.useRef<ToolbarFace>('read');
  /** The last dismissal acted on, so one event is answered once. */
  const answered = React.useRef<Event | null>(null);
  /**
   * The links the reader took the toolbar away from, while they are in one.
   *
   * Two of them, because the reader's two ways of taking it away leave the
   * caret in different places. A press dismisses before it moves the caret, so
   * the link it is about to land in is the one on screen. Escape leaves the
   * caret where it was, which is a link of its own when the pointer had found
   * a different one — and that one would otherwise be raised by the caret
   * route on the next change anyone made.
   */
  const dismissed = React.useRef<readonly TrackedLink[]>([]);
  /**
   * The link the caret was in when it was last asked.
   *
   * A caret that has not left its link has entered nothing, and a keystroke
   * inside it is not a reason to take the toolbar off the link the pointer is
   * resting on: measured, one arrow key pulled the hold back across two
   * paragraphs while the hand was still. A handle rather than the extent it
   * had: a character typed into the link moves that extent, and the record then
   * says the caret has arrived somewhere it has been all along.
   */
  const caretWas = React.useRef<TrackedLink | null>(null);
  /**
   * The same dismissal, kept for the pointer rather than for the caret.
   *
   * Two records because they end at different moments: the caret's ends when
   * the caret leaves the link, the pointer's when the pointer does, and `sync`
   * drops the one above on the next change anyone makes. A handle rather than
   * the positions it was dismissed at: a co-editor writing ahead of the link
   * moves it, and a dismissal recorded as numbers then stops matching — the
   * toolbar came back on the next twitch of a resting hand, which is the one
   * thing Escape is supposed to settle.
   */
  const dismissedByPointer = React.useRef<TrackedLink | null>(null);
  /** Whether the pointer is on the toolbar itself. */
  const pointerOnSurface = React.useRef(false);
  /**
   * Where the pointer last was inside the body, while it is in there.
   *
   * The flag above answers about the link held at the moment it was written,
   * and the hold changes without the pointer moving — a caret walking from one
   * link to another re-points it. Keeping the coordinates lets the question be
   * asked again about whatever link is being considered now.
   */
  const lastPointer = React.useRef<PointerPoint | null>(null);

  /** The link an open is counting down to, once the delay has started. */
  const candidate = React.useRef<HeldLink | null>(null);
  /**
   * Whether an address the reader just wrote is still owed a reading.
   *
   * It is the only word they get that the write landed, so carrying on writing
   * takes it away rather than leaving it standing over text they have moved
   * on from. The pointer ends it the way it ends any other hold — by leaving
   * both the link and the toolbar (A3).
   */
  const unread = React.useRef(false);
  /** The countdown to raising the toolbar, while one is running. */
  const openTimer = React.useRef<number | null>(null);
  /** The countdown to taking it away, while one is running. */
  const closeTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    faceRef.current = face;
  }, [face]);

  /**
   * Whether the pointer is resting on the link the toolbar is about.
   *
   * Asked of the coordinates each time rather than kept as a flag: the hold
   * changes without the pointer moving — the open countdown landing, a caret
   * walking from one link into another — and a flag written at the last move
   * answers about whichever link was held then.
   * @returns True when the pointer is inside the held link's rectangles.
   */
  const pointerOnHeldLink = React.useCallback((): boolean => {
    const at = lastPointer.current;
    const on = heldRef.current;
    return at !== null && on !== null && underPointer(editor, on.range, at);
  }, [editor]);

  /** Stop the toolbar from being raised. */
  const cancelOpen = React.useCallback((): void => {
    if (openTimer.current === null) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);

  /** Stop the toolbar from being taken away. */
  const cancelClose = React.useCallback((): void => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  /**
   * Give the editor the focus when the toolbar is the one holding it.
   *
   * The field takes the focus to be typed into, and a removed focused element
   * drops it on the body, where keystrokes reach nothing at all. Anywhere
   * else the focus is someone else's: a reader typing in the chat column
   * beside the body presses Escape at a toolbar their pointer raised.
   */
  const handFocusBack = React.useCallback((): void => {
    if (surfaceRef.current?.contains(document.activeElement)) {
      viewOf(editor)?.focus();
    }
  }, [editor]);

  /**
   * Say which link the toolbar is about, or let go of the one it has.
   *
   * The one place the hold is written, so every way out hands the focus back
   * rather than only the ways a caller remembered — a co-editor deleting the
   * link under an open field is a way out with no caller at all.
   * @param next - The link to hold, or nothing to let go of it.
   */
  const setHold = React.useCallback(
    (next: HeldLink | null): void => {
      if (next === null) {
        handFocusBack();
        // Nothing is on a toolbar that is not there. The flag is set by an
        // enter and cleared by a leave, and a leave cannot arrive for an
        // element that has been taken away: Escape pressed with the pointer
        // resting on the toolbar removes it without one, and the flag then
        // said the pointer was on a toolbar for the rest of the session — so
        // every close after that was refused.
        pointerOnSurface.current = false;
      }
      // An address left standing is about the link it was written on, and it
      // is the handle that says which link that is: the range and the address
      // both move under a co-editor. Pointing the toolbar at any other link
      // ends that address.
      if (next?.tracked !== heldRef.current?.tracked) unread.current = false;
      heldRef.current = next;
      setHeld(next);
    },
    [handFocusBack],
  );

  /** Let go of the link, and of everything counting down towards it. */
  const closeToolbar = React.useCallback((): void => {
    cancelOpen();
    cancelClose();
    candidate.current = null;
    setHold(null);
  }, [cancelClose, cancelOpen, setHold]);

  /**
   * Let go because the reader asked, and stay away.
   *
   * Every edit in the document re-asks what link the caret is on, so a
   * dismissal that left no trace would last until the next keystroke anyone
   * made. It is about one link: reaching that link again is a fresh ask.
   */
  const dismiss = React.useCallback((): void => {
    const state = editor.prosemirrorState;
    const atCaret = linkAtCaret(state);
    const onScreen = heldRef.current?.tracked ?? null;
    const underCaret = atCaret.range ? trackLink(state, atCaret.range) : null;
    dismissed.current = [onScreen, underCaret].filter(
      (one): one is TrackedLink => one !== null,
    );
    dismissedByPointer.current = onScreen;
    closeToolbar();
  }, [closeToolbar, editor]);

  /**
   * Whether a link is one the reader took the toolbar away from.
   * @param range - The link to ask about, or nothing.
   * @returns True when the reader dismissed it and the record still stands.
   * @throws {never}
   */
  const wasDismissed = React.useCallback(
    (range: LinkRange | null): boolean => {
      if (!range) return false;
      const state = editor.prosemirrorState;
      return dismissed.current.some((one) =>
        sameSpan(resolveTrackedLink(state, one).range, range),
      );
    },
    [editor],
  );

  /** Show the address again, writing nothing. */
  const showAddress = React.useCallback((): void => {
    setFace('read');
    handFocusBack();
  }, [handFocusBack]);

  /** Leave the field the way a dismissal does. */
  const backToRead = React.useCallback((): void => {
    // The address face lasts as long as its own reason does, and for the
    // pointer route that reason is the pointer being on the link or the
    // toolbar. It can have left while the field was up, and nothing will ask
    // again until it moves: the pointer answers by moving, and one sitting
    // still over a page it is no longer pointing at says nothing at all.
    if (
      heldRef.current?.reachedBy === 'pointer' &&
      !pointerOnHeldLink() &&
      !pointerOnSurface.current
    ) {
      dismiss();
      return;
    }
    showAddress();
  }, [dismiss, pointerOnHeldLink, showAddress]);

  /**
   * The link the pointer is resting on, as the document stands.
   *
   * Asked again rather than remembered: the hold changes without the pointer
   * moving — a caret walking from one link into another re-points it — so a
   * flag recorded at the last pointer move answers about a link that is no
   * longer the one in question.
   * @param point - Where the pointer is.
   * @returns The link under it, or nothing when it is over none.
   */
  const linkUnder = React.useCallback(
    (point: PointerPoint): LinkAt | null => {
      const view = viewOf(editor);
      const at = view?.posAtCoords({ left: point.clientX, top: point.clientY });
      // Both sides of the position, settled by the rectangles: where two links
      // meet they share one insertion point, and only the geometry says which
      // run the pointer is over.
      const found = view && at ? linksAtPoint(view.state, at.pos) : [];
      return found.find((link) => underPointer(editor, link.range, point)) ?? null;
    },
    [editor],
  );

  /**
   * Count down to taking the toolbar away, leaving every record alone.
   *
   * Apart from {@link armClose} because the pointer arriving on a link the
   * reader dismissed also has to end whatever is on screen — and that is the
   * one arrival that must not forget the dismissal.
   */
  const startClose = React.useCallback((): void => {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (pointerOnSurface.current || pointerOnHeldLink()) return;
      // A press put the field there, and reaching for the keyboard takes the
      // pointer off the link.
      if (faceRef.current === 'form') return;
      // The caret route ends when the caret leaves, which is not this.
      if (heldRef.current?.reachedBy !== 'pointer') return;
      // A hold the pointer took over a caret's claim is only the pointer's to
      // let go of. The caret is still in whatever link it was in, and that is
      // a standing reason for the toolbar of its own (A6).
      const state = editor.prosemirrorState;
      const atCaret = linkAtCaret(state);
      if (atCaret.range && !wasDismissed(atCaret.range)) {
        setHold({
          tracked: trackLink(state, atCaret.range),
          range: atCaret.range,
          href: atCaret.href,
          reachedBy: 'caret',
        });
        return;
      }
      closeToolbar();
    }, HOVER_CLOSE_DELAY_MS);
  }, [closeToolbar, editor, pointerOnHeldLink, setHold, wasDismissed]);

  /**
   * Start counting down to taking the toolbar away.
   *
   * The reason to close is that the pointer is on neither the link nor the
   * toolbar, which no single event says: leaving one of them is not leaving
   * both. So every leave starts this, and what it finds when it lands decides.
   */
  const armClose = React.useCallback((): void => {
    cancelOpen();
    candidate.current = null;
    // The pointer is off the link it was dismissed on, so reaching it again is
    // a fresh ask.
    dismissedByPointer.current = null;
    startClose();
  }, [cancelOpen, startClose]);

  /**
   * What the toolbar is about once the caret's claim has ended.
   *
   * A pointer resting on a link is a standing reason of its own, so the hold
   * changes hands rather than being let go of (A1) — and the link the reader
   * took the toolbar away from does not come back while the pointer is still
   * on it, which is the same question `armOpen` asks at the other door.
   * @returns The pointer's hold, or nothing to let go.
   */
  const afterTheCaret = React.useCallback((): HeldLink | null => {
    const state = editor.prosemirrorState;
    const under = lastPointer.current ? linkUnder(lastPointer.current) : null;
    const blocked = dismissedByPointer.current
      ? resolveTrackedLink(state, dismissedByPointer.current).range
      : null;
    if (!under || sameSpan(blocked, under.range)) return null;
    return {
      tracked: trackLink(state, under.range),
      range: under.range,
      href: under.href,
      reachedBy: 'pointer',
    };
  }, [editor, linkUnder]);

  /**
   * Whether the caret's claim on the toolbar has ended.
   *
   * Asked in three places — on every change, when the field closes, and when an
   * address that was owed a reading has been read — because a caret hold ends
   * at a moment no single one of them sees. Written once so that a condition
   * added to the question cannot go missing from two of the three answers.
   * @returns True when a caret hold's caret is now inside no link.
   */
  const caretClaimEnded = React.useCallback((): boolean => {
    const current = heldRef.current;
    if (!current || current.reachedBy !== 'caret') return false;
    return linkAtCaret(editor.prosemirrorState).range === null;
  }, [editor]);

  /**
   * Start counting down to raising the toolbar over a link.
   *
   * A pointer already on the link the toolbar is showing only cancels a close;
   * re-holding it would rebuild everything keyed on the hold on every move.
   * @param found - The link under the pointer.
   */
  const armOpen = React.useCallback(
    (found: { range: LinkRange; href: string | null }): void => {
      const state = editor.prosemirrorState;
      const counting = candidate.current?.tracked
        ? resolveTrackedLink(state, candidate.current.tracked).range
        : (candidate.current?.range ?? null);
      // A countdown belongs to the link it was started for, and the pointer
      // arriving on another one ends it — left running, it spends the first
      // link's dwell on the second, and a flick across a neighbour and back
      // opened the toolbar over the neighbour while the pointer rested here.
      //
      // Asked of the handle, which is what "the same link" means while anyone
      // else is writing: a co-editor's edit moves the positions the countdown
      // started with, and comparing those numbers would read a link that has
      // moved as a different one.
      if (candidate.current && !sameSpan(counting, found.range)) {
        cancelOpen();
        candidate.current = null;
      }
      // Staying on a link the reader took the toolbar away from keeps it away.
      // Moving off it is what ends that, which `armClose` records.
      const dismissedNow = dismissedByPointer.current
        ? resolveTrackedLink(state, dismissedByPointer.current).range
        : null;
      // Standing there keeps it away — and takes away whatever else is on
      // screen, because the toolbar showing then is about another link while
      // the pointer is on this one. Two links that touch are the reachable
      // shape: the pointer crosses from one to the other with no sample off
      // either, so nothing else ends the other one's toolbar.
      if (sameSpan(dismissedNow, found.range)) {
        // Before the cancel below, and `startClose` keeps a countdown that is
        // already running: a hand resting on a dismissed link goes on sending
        // moves, and cancelling on each of them left the countdown perpetually
        // 200ms from landing, so the neighbour's toolbar stood for as long as
        // the hand moved.
        startClose();
        return;
      }
      cancelClose();
      const current = heldRef.current;
      if (current && sameSpan(current.range, found.range)) return;
      if (candidate.current) return;
      candidate.current = {
        tracked: trackLink(state, found.range),
        range: found.range,
        href: found.href,
        reachedBy: 'pointer',
      };
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        const next = candidate.current;
        candidate.current = null;
        if (!next) return;
        // Where that link is NOW. The toolbar is measured against the
        // positions it is held with, and a co-editor writing during the delay
        // moves them: measured, a peer typing thirty characters ahead of the
        // link put the toolbar 204px to its left, over other prose, and
        // nothing asked again until the next change anyone made.
        const now = next.tracked
          ? resolveTrackedLink(editor.prosemirrorState, next.tracked)
          : null;
        if (next.tracked && !now?.range) return;
        setHold(now?.range ? { ...next, range: now.range, href: now.href } : next);
        setOpen(true);
      }, HOVER_OPEN_DELAY_MS);
    },
    [cancelClose, cancelOpen, editor, setHold, startClose],
  );

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next, event, reason) => {
      if (next) {
        setOpen(true);
        return;
      }
      // One press, one answer. `useDismiss` hands Escape both to the floating
      // element's own `onKeyDown` (`floating-ui.react.mjs:2845`) and to a
      // listener on the document (`:2782`), so a key pressed with the focus
      // inside the field arrives here twice carrying the same native event.
      // A browser flushes the first answer before the document listener runs,
      // so the second one read the face the first had just stepped back to
      // and took the whole toolbar away — one press doing two dismissals.
      if (event && answered.current === event) return;
      answered.current = event ?? null;
      // Escape out of the field steps back to the address, which then answers
      // for itself whether it is still wanted.
      if (face === 'form' && reason === 'escape-key') {
        backToRead();
        return;
      }
      if (reason === 'escape-key' || reason === 'outside-press') {
        dismiss();
        return;
      }
      closeToolbar();
    },
    placement: 'top-start',
    middleware: [
      offset(LINK_TOOLBAR_GAP),
      // Reads the link's per-line rectangles, so one that wraps gets the
      // toolbar against a line rather than the box drawn around them all.
      inline(),
      flip({ boundary: viewport }),
      shift({ boundary: viewport }),
    ],
    whileElementsMounted: autoUpdate,
  });

  // `bubbles` so Escape reaches the rest of the page: without it the dismissal
  // stops the event in the capture phase (`:2628-2629`).
  const { getFloatingProps } = useInteractions([
    useDismiss(context, { bubbles: { escapeKey: true } }),
  ]);

  // The link's own rectangle, resolved afresh whenever the library asks. No
  // DOM reference goes with it: there is no element that stays the link.
  React.useEffect(() => {
    if (!held) return;
    const reference = panelReference(editor, held.range);
    if (reference) refs.setPositionReference(reference);
  }, [editor, held, refs]);

  // What the document says about the link being held, and about the caret.
  // Both answers change with every edit a co-editor makes, so both are asked
  // again on every one.
  React.useEffect(() => {
    /**
     * Re-ask the document both questions.
     * @param caretMoved - True when the caret itself is what changed.
     */
    const sync = (caretMoved: boolean): void => {
      const state = editor.prosemirrorState;
      const atCaret = linkAtCaret(state);
      const cameFrom = resolveTrackedLink(state, caretWas.current).range;
      caretWas.current = atCaret.range ? trackLink(state, atCaret.range) : null;
      const dismissalHolds = wasDismissed(atCaret.range);
      if (!dismissalHolds) dismissed.current = [];
      /**
       * The link the caret is in, as something to hold.
       * @returns The hold, or nothing when the caret is in no link.
       */
      const caretHold = (): HeldLink | null => {
        if (!atCaret.range) return null;
        return {
          tracked: trackLink(state, atCaret.range),
          range: atCaret.range,
          href: atCaret.href,
          reachedBy: 'caret',
        };
      };
      /**
       * What the toolbar should be about after this change.
       * @returns The hold, or nothing to let go.
       */
      const nextHold = (): HeldLink | null => {
        const current = heldRef.current;
        if (!current) return dismissalHolds ? null : caretHold();
        const now = current.tracked
          ? resolveTrackedLink(state, current.tracked)
          : atCaret;
        if (!now.range) return null;
        // While the field is up the hold is the field's. Pressing Edit does
        // not move the caret, so the caret is wherever the reader last left
        // it, and a co-editor deleting one character can put it on a boundary
        // — which is inside no link as far as `linkAtCaret` is concerned, and
        // that took the field and the half-typed address away with it.
        const fieldIsUp = faceRef.current === 'form';
        // The caret route ends when the caret leaves every link. A pointer
        // resting on that same link is a standing reason of its own, so the
        // hold changes hands rather than being let go of: without that, a
        // caret walking out of a link took the toolbar off the link the
        // pointer was still on, and nothing brought it back (A1).
        if (!fieldIsUp && !unread.current && caretClaimEnded()) {
          return afterTheCaret();
        }
        // A link the caret is IN outranks the one being held, so a caret
        // carried straight from one link into another re-targets rather
        // than leaving the buttons pointed at the link it left.
        if (
          !fieldIsUp &&
          caretMoved &&
          atCaret.range &&
          !sameSpan(atCaret.range, cameFrom) &&
          !sameSpan(atCaret.range, now.range)
        ) {
          return caretHold();
        }
        // The same link, unmoved, is the same hold: a new object here would
        // re-run everything keyed on it once per keystroke anyone makes,
        // taking the drawn selection mark down and putting it back.
        if (sameSpan(current.range, now.range) && current.href === now.href) {
          return current;
        }
        return { ...current, range: now.range, href: now.href };
      };
      setHold(nextHold());
    };
    sync(false);
    const offChange = editor.onChange(() => {
      sync(false);
    });
    const offSelection = editor.onSelectionChange(() => {
      sync(true);
    });
    return () => {
      offChange();
      offSelection();
    };
  }, [afterTheCaret, caretClaimEnded, editor, setHold, wasDismissed]);

  // The field holds the toolbar for as long as it is up, so the question the
  // caret answers is put off until it closes — and no document change is due
  // then, so this is the only place it gets asked again. Left unasked, a
  // toolbar whose caret has moved out of its link stands with nothing left to
  // take it away: the close countdown lets a caret hold alone.
  React.useEffect(() => {
    if (face !== 'read') return;
    // An address just written is owed a reading (see `unread`), and the write
    // is the reason the toolbar is there — the reader's next keystroke ends it.
    if (unread.current) return;
    if (!caretClaimEnded()) return;
    setHold(afterTheCaret());
  }, [afterTheCaret, caretClaimEnded, face, setHold]);

  // Letting go of the link takes the rest of the toolbar with it. Written
  // once here rather than at each place that lets go, so a face and a draft
  // cannot outlive the link they were about — and the next link the reader
  // reaches raises the address rather than someone else's unfinished field.
  // The caret route has no delay to wait on: the link is either under the
  // caret or it is not.
  React.useEffect(() => {
    if (held === null) {
      setOpen(false);
      setFace('read');
      return;
    }
    if (held.reachedBy === 'caret') setOpen(true);
  }, [held]);

  // Which link the pointer is over. One handler on the editor rather than
  // listeners on the anchors: an anchor is not the link, and the coordinates
  // answer for a link drawn as several of them and for one a character long
  // alike. The conditions are on this handler rather than on a library switch,
  // which governs only that library's listeners: a yield that left this
  // running would write the link straight back on the next pointer move.
  React.useEffect(() => {
    const surface = domElementOf(editor);
    if (!surface) return undefined;
    /**
     * Follow the pointer across the body.
     * @param event - The move.
     */
    const onMouseMove = (event: MouseEvent): void => {
      // Where the pointer is stays recorded while the field is up, because
      // that is what says whether the address is still wanted when the field
      // steps back to it. What it points AT is asked for only when there is
      // something to do with the answer: resolving it reads the document and
      // measures a DOM range, on every move over the body.
      lastPointer.current = { clientX: event.clientX, clientY: event.clientY };
      if (faceRef.current !== 'read' || yielding) return;
      const hit = linkUnder(lastPointer.current);
      if (hit === null) {
        armClose();
        return;
      }
      armOpen(hit);
    };
    /** The pointer has left the body altogether. */
    const onMouseLeave = (): void => {
      lastPointer.current = null;
      armClose();
    };
    /** The reader has moved on from an address they just wrote. */
    // Reading the address is what the keystroke says has happened, so what
    // stands afterwards is whatever would have stood without it: the caret's
    // link while the caret is in one, the pointer's while it rests on one.
    const onKeyDown = (): void => {
      if (!unread.current) return;
      unread.current = false;
      if (!caretClaimEnded()) return;
      setHold(afterTheCaret());
    };
    surface.addEventListener('mousemove', onMouseMove);
    surface.addEventListener('mouseleave', onMouseLeave);
    surface.addEventListener('keydown', onKeyDown);
    return () => {
      surface.removeEventListener('mousemove', onMouseMove);
      surface.removeEventListener('mouseleave', onMouseLeave);
      surface.removeEventListener('keydown', onKeyDown);
    };
  }, [
    afterTheCaret,
    armClose,
    armOpen,
    caretClaimEnded,
    editor,
    linkUnder,
    setHold,
    yielding,
  ]);

  // Nothing counting down outlives the toolbar.
  React.useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
    },
    [cancelClose, cancelOpen],
  );

  // Standing aside takes the pointer's link away. A caret inside a link is not
  // reachable while another control owns the same text, so that route needs
  // nothing here.
  React.useEffect(() => {
    if (!yielding) return;
    // The countdown as well as the toolbar: a yield that only closes cannot
    // stop one already in flight, and the handler that reads the yield stops
    // new ones rather than running ones.
    cancelOpen();
    candidate.current = null;
    if (held?.reachedBy === 'pointer') closeToolbar();
  }, [cancelOpen, closeToolbar, held, yielding]);

  // The link is drawn as selected for exactly as long as the field is up.
  React.useEffect(() => {
    if (face !== 'form' || !held) return undefined;
    showLinkEditSpan(viewOf(editor), held.tracked);
    return () => {
      showLinkEditSpan(viewOf(editor), null);
    };
  }, [editor, face, held]);

  // Entering the field hands it the focus with its contents selected, so the
  // address can be replaced by typing.
  React.useEffect(() => {
    if (face !== 'form') return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [face]);

  /** The pointer has come onto the toolbar. */
  const takeSurface = React.useCallback((): void => {
    pointerOnSurface.current = true;
    cancelClose();
  }, [cancelClose]);

  /** The pointer has gone off the toolbar. */
  const releaseSurface = React.useCallback((): void => {
    pointerOnSurface.current = false;
    armClose();
  }, [armClose]);

  /** Swap the address for the field. */
  const startEdit = React.useCallback((): void => {
    setFace('form');
  }, []);

  /** Where the held link is in the document as it stands. */
  const heldRangeNow = React.useCallback((): LinkRange | null => {
    if (!held) return null;
    return held.tracked
      ? resolveTrackedLink(editor.prosemirrorState, held.tracked).range
      : held.range;
  }, [editor, held]);

  /**
   * Write what is in the field onto the link this toolbar opened over.
   *
   * The handle resolves to the link as it stands now, so an address confirmed
   * after a co-editor wrote beside it still lands on the link the reader was
   * looking at.
   */
  const submit = React.useCallback(
    (href: string): void => {
      const target = heldRangeNow();
      if (target) applyLink(editor, target, href);
      unread.current = true;
      showAddress();
    },
    [editor, heldRangeNow, showAddress],
  );

  /** Take the link off, and put the toolbar away. */
  const unlink = React.useCallback((): void => {
    const target = heldRangeNow();
    if (target) removeLink(editor, target);
    closeToolbar();
  }, [closeToolbar, editor, heldRangeNow]);

  /**
   * Hold the toolbar's element for both the library and `handFocusBack`.
   * @param element - The element, or null as it is taken away.
   */
  const holdSurface = React.useCallback(
    (element: HTMLDivElement | null): void => {
      surfaceRef.current = element;
      refs.setFloating(element);
    },
    [refs],
  );

  if (!open || !held) return null;

  return (
    <FloatingPortal root={viewport}>
      <div
        ref={holdSurface}
        style={floatingStyles}
        data-testid='doc-link-toolbar'
        className={LINK_PANEL_SURFACE}
        {...getFloatingProps({
          onMouseEnter: takeSurface,
          onMouseLeave: releaseSurface,
        })}
      >
        {face === 'read' ? (
          <DocumentLinkRead
            href={held.href}
            onEdit={startEdit}
            onRemove={unlink}
          />
        ) : (
          <DocumentLinkForm
            initial={held.href ?? ''}
            onSubmit={submit}
            inputRef={inputRef}
          />
        )}
      </div>
    </FloatingPortal>
  );
}
