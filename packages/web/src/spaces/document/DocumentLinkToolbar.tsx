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
  LINK_TOOLBAR_OPEN_DELAY_MS,
  LINK_TOOLBAR_CLOSE_DELAY_MS,
} from '@web/spaces/document/link-toolbar-timing';

/** Which of the toolbar's two faces is showing. */
type ToolbarFace = 'read' | 'form';

/**
 * Why the toolbar is standing on a link.
 *
 * The two reasons of §6.1.1. Each names one link, each starts and ends on
 * its own, and the toolbar is about whichever of them most recently arrived.
 */
type HoldReason = 'pointer' | 'caret';

/** A link the reader took the toolbar away from, and what was standing on it. */
interface Dismissal {
  /** The link, tracked so a co-editor's writing does not lose it. */
  tracked: TrackedLink;
  /** The caret was in it when the toolbar was taken away. */
  byCaret: boolean;
  /** The pointer was resting on it when the toolbar was taken away. */
  byPointer: boolean;
}

/** The link the toolbar is about, and how it was reached. */
interface HeldLink {
  /** The handle that follows the link through a co-editor's writing. */
  readonly tracked: TrackedLink | null;
  /** Where it is now. */
  readonly range: LinkRange;
  /** The address, as stored on it. */
  readonly href: string | null;
  /** Which standing reason the toolbar is about this link for (§6.1.1). */
  readonly reachedBy: HoldReason;
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
   * The links the reader was on when they took the toolbar away.
   *
   * Up to two, because the reader can be on two at once — the pointer resting
   * on one while the caret sits in another — and Escape takes away the whole
   * of that moment.
   *
   * A record covers its link against every reason, and ends when the reasons
   * that RAISED it have all left. Both halves are load-bearing. Covering the
   * whole link is what makes a press on one stick: the press dismisses before
   * it moves the caret, so the caret lands in a link it would otherwise be a
   * standing reason to raise. Ending on the reasons that were there is what
   * lets the reader come back to it: with the hand gone, the caret that press
   * dropped in would otherwise hold the record open for as long as it sat
   * there, and reaching for the link again answered with nothing.
   *
   * Handles rather than the extents they were dismissed at: a co-editor
   * writing ahead of a link moves it, and numbers stop matching.
   */
  const dismissed = React.useRef<readonly Dismissal[]>([]);
  /**
   * The link the caret was in when the hold was last worked out.
   *
   * What makes an arrival an arrival. A caret that has not left its link has
   * entered nothing, and a keystroke inside it is no reason to take the
   * toolbar off the link the pointer rests on.
   */
  const caretWas = React.useRef<TrackedLink | null>(null);
  /**
   * The link the pointer has come to rest on, while it is still there.
   *
   * Written when the open countdown lands, cleared when the close countdown
   * lands and finds the pointer on neither this link nor the toolbar. It is
   * the pointer's standing reason: the toolbar is about it because the hand is
   * there, whether the hand is over the text or over the toolbar it raised.
   */
  const pointerOn = React.useRef<TrackedLink | null>(null);
  /** The pointer's link as the hold was last worked out, for the same reason. */
  const pointerWas = React.useRef<TrackedLink | null>(null);
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
  /** The yield as the timers see it; they run long after the prop changed. */
  const yieldingRef = React.useRef(yielding);
  /** The countdown to raising the toolbar, while one is running. */
  const openTimer = React.useRef<number | null>(null);
  /** The countdown to taking it away, while one is running. */
  const closeTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    faceRef.current = face;
  }, [face]);

  React.useEffect(() => {
    yieldingRef.current = yielding;
  }, [yielding]);

  /**
   * Whether the pointer is still inside the link its reason names.
   *
   * Asked of the coordinates each time rather than kept as a flag: the hold
   * changes without the pointer moving — the open countdown landing, a caret
   * walking from one link into another — and a flag written at the last move
   * answers about whichever link was held then.
   * @returns True when the pointer is inside that link's rectangles.
   */
  const pointerRestsOnIt = React.useCallback((): boolean => {
    const at = lastPointer.current;
    if (at === null || pointerOn.current === null) return false;
    const where = resolveTrackedLink(editor.prosemirrorState, pointerOn.current);
    return where.range !== null && underPointer(editor, where.range, at);
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
      heldRef.current = next;
      setHeld(next);
    },
    [handFocusBack],
  );

  /**
   * Work out what the toolbar is about, and say so.
   *
   * The ONE place the hold is decided (design §6.1.1). Every handler updates a
   * fact — where the pointer has come to rest, what the reader dismissed,
   * whether an address is owed a reading — and calls this; none of them writes
   * the hold. Six rounds of review found defects only where one door asked
   * fewer of these questions than another door asked, so there is one door.
   */
  const settle = React.useCallback((): void => {
    const state = editor.prosemirrorState;
    /**
     * Where a handle's link sits now.
     * @param one - The handle, or nothing.
     * @returns The extent, or null when it reaches no link any more.
     */
    const spanOf = (one: TrackedLink | null): LinkRange | null =>
      resolveTrackedLink(state, one).range;

    const atCaret = linkAtCaret(state);
    const atPointer = resolveTrackedLink(state, pointerOn.current);

    // A dismissal lasts while a reason that raised it is still on its link.
    dismissed.current = dismissed.current.filter((one) => {
      const where = spanOf(one.tracked);
      if (where === null) return false;
      return (
        (one.byCaret && sameSpan(where, atCaret.range)) ||
        (one.byPointer && sameSpan(where, atPointer.range))
      );
    });
    /**
     * Whether the reader took the toolbar away from this link.
     * @param range - The link to ask about.
     * @returns True while that dismissal stands.
     */
    const taken = (range: LinkRange | null): boolean =>
      range !== null &&
      dismissed.current.some((one) => sameSpan(spanOf(one.tracked), range));

    const byCaret: HeldLink | null =
      atCaret.range && !taken(atCaret.range)
        ? {
          tracked: trackLink(state, atCaret.range),
          range: atCaret.range,
          href: atCaret.href,
          reachedBy: 'caret',
        }
        : null;
    const byPointer: HeldLink | null =
      atPointer.range && !taken(atPointer.range)
        ? {
          tracked: pointerOn.current,
          range: atPointer.range,
          href: atPointer.href,
          reachedBy: 'pointer',
        }
        : null;

    // Which reasons are NEW since the last time this ran. The caret's is asked
    // of its handle: a character typed into a link moves its extent, and
    // numbers would report a caret that never left as having arrived.
    const caretCame =
      byCaret !== null && !sameSpan(spanOf(caretWas.current), byCaret.range);
    const pointerCame = byPointer !== null && pointerOn.current !== pointerWas.current;
    caretWas.current = byCaret?.tracked ?? null;
    pointerWas.current = pointerOn.current;

    if (yieldingRef.current) {
      setHold(null);
      setOpen(false);
      return;
    }
    // The field owns the toolbar while it is up, so the question is put off to
    // the moment it closes — unless the link it is about has gone, which
    // leaves the field with nothing to write to.
    if (faceRef.current === 'form') {
      const current = heldRef.current;
      if (current && current.tracked && !spanOf(current.tracked)) setHold(null);
      return;
    }

    /**
     * Take a hold, or keep the one standing when it is the same link.
     * @param next - What the toolbar is about now, or nothing.
     */
    const stand = (next: HeldLink | null): void => {
      const current = heldRef.current;
      // The same link is the same hold: a new object would rebuild everything
      // keyed on it once per keystroke anyone makes, taking the drawn mark
      // down and putting it back.
      if (
        current &&
        next &&
        current.reachedBy === next.reachedBy &&
        sameSpan(current.range, next.range) &&
        current.href === next.href
      ) {
        return;
      }
      setHold(next);
      setOpen(next !== null);
    };

    if (caretCame || pointerCame) {
      stand(caretCame ? byCaret : byPointer);
      return;
    }
    const current = heldRef.current;
    const stillStands =
      current !== null &&
      ((current.reachedBy === 'pointer' && byPointer !== null) ||
        (current.reachedBy === 'caret' &&
          byCaret !== null &&
          sameSpan(spanOf(current.tracked), byCaret.range)));
    if (stillStands) {
      stand(current.reachedBy === 'pointer' ? byPointer : byCaret);
      return;
    }
    stand(byPointer ?? byCaret);
  }, [editor, setHold]);

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
    const underCaret = atCaret.range ? trackLink(state, atCaret.range) : null;
    const onCaret = atCaret.range;
    const onPointer = resolveTrackedLink(state, pointerOn.current).range;
    /**
     * Record one link, saying which reasons were standing on it.
     * @param tracked - The link.
     * @param where - Its extent now, against which the other reason is asked.
     * @returns The record.
     */
    const record = (tracked: TrackedLink, where: LinkRange | null): Dismissal => ({
      tracked,
      byCaret: sameSpan(where, onCaret),
      byPointer: sameSpan(where, onPointer),
    });
    dismissed.current = [
      pointerOn.current ? record(pointerOn.current, onPointer) : null,
      underCaret ? record(underCaret, onCaret) : null,
    ].filter((one): one is Dismissal => one !== null);
    cancelOpen();
    candidate.current = null;
    // The field goes with it: a dismissal is the reader taking the whole
    // toolbar away, and what is left standing is asked without it.
    faceRef.current = 'read';
    setFace('read');
    settle();
  }, [cancelOpen, editor, settle]);

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
   * Count down to the pointer's reason ending.
   *
   * The reason ends when the pointer is on neither the link nor the toolbar,
   * which no single event says: leaving one of them is not leaving both. So
   * every leave starts this, and what it finds when it lands decides.
   */
  const startClose = React.useCallback((): void => {
    if (closeTimer.current !== null) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // The pointer is on neither the link nor the toolbar it raised, so its
      // reason has ended. What is left standing is the one question, asked in
      // the one place.
      if (pointerOnSurface.current || pointerRestsOnIt()) return;
      // A press put the field there, and reaching for the keyboard takes the
      // pointer off the link.
      if (faceRef.current === 'form') return;
      pointerOn.current = null;
      settle();
    }, LINK_TOOLBAR_CLOSE_DELAY_MS);
  }, [pointerRestsOnIt, settle]);

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
    startClose();
  }, [cancelOpen, startClose]);

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
      cancelClose();
      // Already resting on this link: the reason stands, and re-taking it
      // would rebuild everything keyed on the hold on every move.
      if (sameSpan(resolveTrackedLink(state, pointerOn.current).range, found.range)) {
        return;
      }
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
        const now = resolveTrackedLink(editor.prosemirrorState, next.tracked);
        if (next.tracked && !now.range) {
          // What the pointer travelled to is gone. Its reason ends here, and
          // whatever else stands answers for the toolbar.
          pointerOn.current = null;
          settle();
          return;
        }
        pointerOn.current = next.tracked;
        settle();
      }, LINK_TOOLBAR_OPEN_DELAY_MS);
    },
    [cancelClose, cancelOpen, editor, settle],
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
  // stops the event as it bubbles (`:2628-2629`).
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

  // Every change anyone makes can move a link, delete one, or move the caret
  // into or out of one, so every change re-asks the one question.
  React.useEffect(() => {
    settle();
    const offChange = editor.onChange(settle);
    const offSelection = editor.onSelectionChange(settle);
    return () => {
      offChange();
      offSelection();
    };
  }, [editor, settle]);

  // The field holds the toolbar for as long as it is up, so the question is
  // put off until it closes — and no document change is due then, so this is
  // the only place it gets asked again.
  React.useEffect(() => {
    if (face !== 'read') return;
    // The pointer can have left while the field was up, and the countdown that
    // would have ended its reason refuses to land while the field is there.
    if (pointerOn.current && !pointerRestsOnIt() && !pointerOnSurface.current) {
      pointerOn.current = null;
    }
    settle();
  }, [face, pointerRestsOnIt, settle]);

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
    surface.addEventListener('mousemove', onMouseMove);
    surface.addEventListener('mouseleave', onMouseLeave);
    return () => {
      surface.removeEventListener('mousemove', onMouseMove);
      surface.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [armClose, armOpen, editor, linkUnder, settle, yielding]);

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
    settle();
  }, [cancelOpen, settle, yielding]);

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
      dismiss();
    },
    [dismiss, editor, heldRangeNow],
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
