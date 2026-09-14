// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The toolbar over a link the pointer is hovering or the caret is inside.
 *
 * It owns what it shows. The two routes in are its own — a `mouseover` on the
 * editor for the pointer, the document's own change events for the caret — and
 * the link it is about is held by a Yjs handle, the same way the panel holds
 * one. floating-ui supplies the timing and the position; its `onOpenChange`
 * says why a close is being asked for, and this dispatches on that.
 *
 * Two references, and both are needed. `useHover` registers every one of its
 * listeners inside a check for a real DOM reference
 * (`floating-ui.react.mjs:887`), while `refs.setPositionReference` never
 * writes one (`:2947-2957`) — measured, an anchor given only a position
 * reference raises nothing at all
 * (`engineering/demo/2026-09-14-floating-ui-references.probe.tsx`). So the
 * anchor element goes to `refs.setReference` for the interactions and the
 * range-derived virtual element to `refs.setPositionReference` for the
 * geometry. The same measurement is what makes a press on the link count as
 * inside rather than as a press outside.
 *
 * It writes through `document-link.ts` rather than the extension's own
 * `editLink`, which adds the mark with no check at all, so a `javascript:`
 * address typed in here would reach every peer.
 */

import * as React from 'react';
import {
  useFloating,
  useHover,
  useDismiss,
  useInteractions,
  FloatingPortal,
  autoUpdate,
  offset,
  inline,
  flip,
  shift,
  safePolygon,
} from '@floating-ui/react';

import { DocumentLinkRead } from '@web/spaces/document/DocumentLinkRead';
import { DocumentLinkForm } from '@web/spaces/document/DocumentLinkForm';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import { LINK_PANEL_SURFACE } from '@web/spaces/document/document-link-panel';
import { panelReference } from '@web/spaces/document/document-link-anchor';
import {
  linkAtElement,
  linkAtCaret,
  anchorsOfLink,
} from '@web/spaces/document/document-link-at';
import {
  trackLink,
  resolveTrackedLink,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import {
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  LINK_ANCHOR_SELECTOR,
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
  /**
   * The anchor the pointer entered, null for the caret route.
   *
   * A link drawn as several anchors has only this one to say which of them
   * the pointer is on, and `useHover` binds its listeners to a single
   * element. It is replaced by a write, so it is used only while the document
   * still holds it.
   */
  readonly enteredEl: HTMLElement | null;
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
 * Whether a close was asked for because the pointer left.
 *
 * Leaving the toolbar and leaving the link arrive under different reasons:
 * the toolbar's is the default `'hover'` (`floating-ui.react.mjs:884`), while
 * the link's goes through `safePolygon` and carries `'safe-polygon'`
 * (`:838`). The library itself treats the two as one (`:2029`).
 * @param reason - What floating-ui said the close was for.
 * @returns True for either of the two pointer leaves.
 * @throws {never}
 */
function leftByPointer(reason: string | undefined): boolean {
  return reason === 'hover' || reason === 'safe-polygon';
}

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
 * The anchor floating-ui binds its pointer listeners to.
 *
 * The one the pointer entered while the document still holds it: a link drawn
 * as several anchors has no other way to say which of them the reader is on.
 * A write replaces the element, and the link is then asked for its anchors
 * again.
 * @param editor - The editor holding the link.
 * @param held - The link the toolbar is about.
 * @returns The anchor, or nothing for the caret route and for a link the
 *   document no longer draws.
 * @throws {never}
 */
function pointerAnchor(
  editor: ViewedEditor,
  held: HeldLink,
): HTMLElement | null {
  if (held.reachedBy !== 'pointer') return null;
  if (held.enteredEl?.isConnected) return held.enteredEl;
  return anchorsOfLink(editor, held.range)[0] ?? null;
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
  const [draft, setDraft] = React.useState('');
  const [showInvalid, setShowInvalid] = React.useState(false);
  /** True while the address on screen is the result of a write just made. */
  const [settled, setSettled] = React.useState(false);
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
  /** The last dismissal acted on, so one event is answered once. */
  const answered = React.useRef<Event | null>(null);
  /** The link the reader took the toolbar away from, while they are in it. */
  const dismissed = React.useRef<TrackedLink | null>(null);
  /** Whether the pointer is on the link or the toolbar, as `useHover` says. */
  const pointerOn = React.useRef(false);

  /** The pointer is on one of the two things the toolbar answers to. */
  const markPointerOn = React.useCallback((): void => {
    pointerOn.current = true;
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
      if (next === null) handFocusBack();
      // An address left standing after a write is about the link it was
      // written on, and it is the handle that says which link that is: the
      // range and the address itself both move under a co-editor. Pointing
      // the toolbar at any other link ends that address, so the next link
      // the reader reaches is owed the pointer's own reasons for going.
      if (next?.tracked !== heldRef.current?.tracked) setSettled(false);
      heldRef.current = next;
      setHeld(next);
    },
    [handFocusBack],
  );

  /**
   * Let go because the reader asked, and stay away.
   *
   * Every edit in the document re-asks what link the caret is on, so a
   * dismissal that left no trace would last until the next keystroke anyone
   * made. It is about one link: reaching that link again is a fresh ask.
   */
  const dismiss = React.useCallback((): void => {
    dismissed.current = held?.tracked ?? null;
    setHold(null);
  }, [held, setHold]);

  /** Show the address again, writing nothing. */
  const showAddress = React.useCallback((): void => {
    setFace('read');
    setDraft('');
    setShowInvalid(false);
    handFocusBack();
  }, [handFocusBack]);

  /** Leave the field the way a dismissal does. */
  const backToRead = React.useCallback((): void => {
    // The address face lasts as long as its own reason does, and for the
    // pointer route that reason is the pointer being on the link or the
    // toolbar. It can have left while the field was up, with the library's
    // pointer listeners answering to the field rather than to the address.
    if (held?.reachedBy === 'pointer' && !pointerOn.current) {
      dismiss();
      return;
    }
    showAddress();
  }, [dismiss, held, showAddress]);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (next, event, reason) => {
      // Where the pointer is, as the library sees it. Read by `backToRead`,
      // which needs it for a leave that happened while the field was up.
      // Leaving the link and leaving the toolbar arrive under different
      // reasons — the library treats the pair as one (`:2029`) and so does
      // this: the reference's leave goes through `safePolygon`, which closes
      // with `'safe-polygon'` (`:838`).
      if (leftByPointer(reason)) pointerOn.current = next;
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
      // The field outlasts the pointer: a press put it there, and the reader
      // reaching for the keyboard takes the pointer off the link.
      if (face === 'form' && leftByPointer(reason)) return;
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
      setHold(null);
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

  const { getFloatingProps } = useInteractions([
    useHover(context, {
      // The caret route opens and closes itself; the pointer route is the one
      // with a delay and a travel to the toolbar. Left on while the field is
      // up as well, so where the pointer went is still known when the field
      // steps back to the address.
      enabled: held?.reachedBy === 'pointer',
      delay: { open: HOVER_OPEN_DELAY_MS, close: HOVER_CLOSE_DELAY_MS },
      handleClose: safePolygon(),
    }),
    // `bubbles` so Escape reaches the rest of the page: without it the
    // dismissal stops the event in the capture phase (`:2628-2629`).
    useDismiss(context, { bubbles: { escapeKey: true } }),
  ]);

  // The anchor for the interactions, the link's own rectangle for the
  // geometry. Position last: it writes the position reference and leaves the
  // DOM one alone, while `setReference` writes both.
  React.useEffect(() => {
    if (!held) return;
    const anchor = pointerAnchor(editor, held);
    if (anchor) refs.setReference(anchor);
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
      const standing = dismissed.current
        ? resolveTrackedLink(state, dismissed.current).range
        : null;
      const dismissalHolds = sameSpan(standing, atCaret.range);
      if (!dismissalHolds) dismissed.current = null;
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
          enteredEl: null,
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
        // The caret route ends when the caret leaves every link.
        if (current.reachedBy === 'caret' && !atCaret.range) return null;
        // A link the caret is IN outranks the one being held, so a caret
        // carried straight from one link into another re-targets rather
        // than leaving the buttons pointed at the link it left.
        if (caretMoved && atCaret.range && !sameSpan(atCaret.range, now.range)) {
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
  }, [editor, setHold]);

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
      setDraft('');
      setShowInvalid(false);
      return;
    }
    if (held.reachedBy === 'caret') setOpen(true);
  }, [held]);

  // Which link the pointer is over. The conditions are on this handler rather
  // than on `useHover`'s own switch, which governs only the library's
  // listeners: a yield that left this running would write the link straight
  // back on the next pointer move.
  React.useEffect(() => {
    const surface = domElementOf(editor);
    if (!surface) return undefined;
    /**
     * Take hold of the link the pointer has moved onto.
     * @param event - The move.
     */
    const onMouseOver = (event: MouseEvent): void => {
      if (face !== 'read' || yielding) return;
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest<HTMLElement>(LINK_ANCHOR_SELECTOR);
      if (!anchor) return;
      const found = linkAtElement(editor, anchor);
      if (!found.range) return;
      pointerOn.current = true;
      setHold({
        tracked: trackLink(editor.prosemirrorState, found.range),
        range: found.range,
        href: found.href,
        reachedBy: 'pointer',
        enteredEl: anchor,
      });
    };
    surface.addEventListener('mouseover', onMouseOver);
    return () => {
      surface.removeEventListener('mouseover', onMouseOver);
    };
  }, [editor, face, setHold, yielding]);

  // Standing aside takes the pointer's link away. A caret inside a link is not
  // reachable while another control owns the same text, so that route needs
  // nothing here.
  React.useEffect(() => {
    if (yielding && held?.reachedBy === 'pointer') setHold(null);
  }, [held, setHold, yielding]);

  // Where the pointer came back to. `useHover` reports a leave but not a
  // return once it is open (`floating-ui.react.mjs:807`, `:879` — the one
  // clears a timer and says nothing), so without this the record of the
  // pointer having left would never be undone and Escape out of the field
  // would take the whole toolbar away however long the pointer has been
  // sitting on it. The toolbar's own half of it is a prop below; this is the
  // link's, which is not ours to render.
  React.useEffect(() => {
    if (held?.reachedBy !== 'pointer') return undefined;
    // Every anchor of the link, so coming back to any part of one drawn in
    // several counts as coming back to it.
    const anchors = anchorsOfLink(editor, held.range);
    anchors.forEach((anchor) => {
      anchor.addEventListener('mouseenter', markPointerOn);
    });
    return () => {
      anchors.forEach((anchor) => {
        anchor.removeEventListener('mouseenter', markPointerOn);
      });
    };
  }, [editor, held, markPointerOn]);

  // An address left standing after a write goes on the reader's next
  // keystroke: it is the only word they get that the write landed, and a
  // keystroke is them saying they have read it.
  React.useEffect(() => {
    if (!settled) return undefined;
    const surface = domElementOf(editor);
    if (!surface) return undefined;
    /** The reader has moved on. */
    const readIt = (): void => {
      setHold(null);
    };
    surface.addEventListener('keydown', readIt);
    return () => {
      surface.removeEventListener('keydown', readIt);
    };
  }, [editor, setHold, settled]);

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

  /** Swap the address for the field. */
  const startEdit = React.useCallback((): void => {
    setSettled(false);
    setDraft(held?.href ?? '');
    setShowInvalid(false);
    setFace('form');
  }, [held]);

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
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    const target = heldRangeNow();
    if (target) applyLink(editor, target, normalizeLinkUrl(draft));
    // The address the write landed on is the only confirmation the reader
    // gets that it landed, so this face is shown whether or not the pointer
    // is still on the link — and stands until they have read it.
    setSettled(true);
    showAddress();
  }, [draft, editor, heldRangeNow, showAddress]);

  /** Take the link off, and put the toolbar away. */
  const unlink = React.useCallback((): void => {
    const target = heldRangeNow();
    if (target) removeLink(editor, target);
    setHold(null);
  }, [editor, heldRangeNow, setHold]);

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

  /** Take what was typed, and drop any refusal the last address earned. */
  const changeDraft = React.useCallback((next: string): void => {
    setDraft(next);
    setShowInvalid(false);
  }, []);

  if (!open || !held) return null;

  return (
    <FloatingPortal root={viewport}>
      <div
        ref={holdSurface}
        style={floatingStyles}
        data-testid='doc-link-toolbar'
        className={LINK_PANEL_SURFACE}
        {...getFloatingProps({ onMouseEnter: markPointerOn })}
      >
        {face === 'read' ? (
          <DocumentLinkRead
            href={held.href}
            onEdit={startEdit}
            onRemove={unlink}
          />
        ) : (
          <DocumentLinkForm
            draft={draft}
            showInvalid={showInvalid}
            onDraftChange={changeDraft}
            onSubmit={submit}
            inputRef={inputRef}
          />
        )}
      </div>
    </FloatingPortal>
  );
}
