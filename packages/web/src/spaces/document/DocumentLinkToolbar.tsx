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
 * writes one (`:2995-3003`) — measured, an anchor given only a position
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
  /** The anchor, for floating-ui to bind its interactions to. */
  readonly anchorEl: HTMLElement | null;
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
  const inputRef = React.useRef<HTMLInputElement>(null);
  /** The last dismissal acted on, so one event is answered once. */
  const answered = React.useRef<Event | null>(null);

  /** Take the toolbar off the screen, releasing what it held. */
  const closeToolbar = React.useCallback((): void => {
    setHeld(null);
    setOpen(false);
    setFace('read');
    setDraft('');
    setShowInvalid(false);
  }, []);

  /**
   * Put the toolbar back to the address, writing nothing.
   *
   * The focus comes back here: the field took it to be typed into and is
   * being removed, and a removed focused element drops the focus on the body,
   * where ProseMirror stops reading the browser's selection back.
   */
  const backToRead = React.useCallback((): void => {
    setFace('read');
    setDraft('');
    setShowInvalid(false);
    viewOf(editor)?.focus();
  }, [editor]);

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
      // Escape out of the field steps back to the address: the reader is at
      // the keyboard with the pointer still on the link, and what they
      // dismissed is what they were typing. A press somewhere else is the
      // other thing — they have taken the pointer off the link the toolbar
      // hangs from, so the toolbar goes with it.
      if (face === 'form' && reason === 'escape-key') {
        backToRead();
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

  const { getFloatingProps } = useInteractions([
    useHover(context, {
      // The caret route opens and closes itself; the pointer route is the one
      // with a delay and a travel to the toolbar.
      enabled: held?.reachedBy === 'pointer' && face === 'read',
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
    if (held.anchorEl) refs.setReference(held.anchorEl);
    const reference = panelReference(editor, held.range);
    if (reference) refs.setPositionReference(reference);
  }, [editor, held, refs]);

  // What the document says about the link being held, and about the caret.
  // Both answers change with every edit a co-editor makes, so both are asked
  // again on every one.
  React.useEffect(() => {
    /** Re-ask the document both questions. */
    const sync = (): void => {
      const state = editor.prosemirrorState;
      const atCaret = linkAtCaret(state);
      setHeld((current) => {
        if (current) {
          const now = current.tracked
            ? resolveTrackedLink(state, current.tracked)
            : atCaret;
          if (!now.range) return null;
          // The caret route ends when the caret leaves the link.
          if (current.reachedBy === 'caret' && !atCaret.range) return null;
          return { ...current, range: now.range, href: now.href };
        }
        if (!atCaret.range) return null;
        return {
          tracked: trackLink(state, atCaret.range),
          range: atCaret.range,
          href: atCaret.href,
          reachedBy: 'caret',
          anchorEl: null,
        };
      });
    };
    sync();
    const offChange = editor.onChange(sync);
    const offSelection = editor.onSelectionChange(sync);
    return () => {
      offChange();
      offSelection();
    };
  }, [editor]);

  // The caret route has no delay to wait on: the link is either under the
  // caret or it is not.
  React.useEffect(() => {
    if (held === null) setOpen(false);
    else if (held.reachedBy === 'caret') setOpen(true);
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
      const anchor = target?.closest<HTMLElement>(
        'a[data-inline-content-type="link"]',
      );
      if (!anchor) return;
      const found = linkAtElement(editor, anchor);
      if (!found.range) return;
      setHeld({
        tracked: trackLink(editor.prosemirrorState, found.range),
        range: found.range,
        href: found.href,
        reachedBy: 'pointer',
        anchorEl: anchor,
      });
    };
    surface.addEventListener('mouseover', onMouseOver);
    return () => {
      surface.removeEventListener('mouseover', onMouseOver);
    };
  }, [editor, face, yielding]);

  // Standing aside takes the pointer's link away. A caret inside a link is not
  // reachable while another control owns the same text, so that route needs
  // nothing here.
  React.useEffect(() => {
    if (yielding && held?.reachedBy === 'pointer') closeToolbar();
  }, [closeToolbar, held, yielding]);

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
    backToRead();
  }, [backToRead, draft, editor, heldRangeNow]);

  /** Take the link off, and put the toolbar away. */
  const unlink = React.useCallback((): void => {
    const target = heldRangeNow();
    if (target) removeLink(editor, target);
    closeToolbar();
  }, [closeToolbar, editor, heldRangeNow]);

  /** Take what was typed, and drop any refusal the last address earned. */
  const changeDraft = React.useCallback((next: string): void => {
    setDraft(next);
    setShowInvalid(false);
  }, []);

  if (!open || !held) return null;

  return (
    <FloatingPortal root={viewport}>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        data-testid='doc-link-toolbar'
        className={LINK_PANEL_SURFACE}
        {...getFloatingProps()}
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
