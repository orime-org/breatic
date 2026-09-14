// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The toolbar over a link the pointer is hovering or the caret is inside.
 *
 * `LinkToolbarController` decides when it shows and where — the delay, the
 * travel from link to toolbar, the position, the dismiss — and hands the link
 * it found to whatever component it is given. This is that component: the two
 * faces, and what each press on them means.
 *
 * It writes through `document-link.ts` rather than the extension's own
 * `editLink`, which adds the mark with no check at all, so a `javascript:`
 * address typed in here would reach every peer.
 */

import * as React from 'react';
import type { LinkToolbarProps } from '@blocknote/react';
import { TextSelection } from '@tiptap/pm/state';

import { DocumentLinkRead } from '@web/spaces/document/DocumentLinkRead';
import { DocumentLinkForm } from '@web/spaces/document/DocumentLinkForm';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import { LINK_PANEL_SURFACE } from '@web/spaces/document/document-link-panel';
import {
  trackLink,
  resolveTrackedLink,
  holdPoint,
  pointNow,
  type TrackedLink,
  type HeldPoint,
} from '@web/spaces/document/document-link-tracking';
import {
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  resolveLinkInSpan,
} from '@web/spaces/document/document-link';
import {
  viewOf,
  type ViewedEditor,
} from '@web/spaces/document/document-editor-view';

/** Which of the toolbar's two faces is showing. */
type ToolbarFace = 'read' | 'form';

/**
 * The toolbar over one link.
 * @param props - The link the controller found, plus the editor to write to.
 * @param props.editor - The editor holding the link.
 * @param props.url - The address currently stored on it.
 * @param props.range - The span it covers.
 * @param props.setToolbarOpen - Closes the toolbar; the controller owns that.
 * @param props.setToolbarPositionFrozen - Holds the toolbar where it is.
 * @returns The toolbar.
 */
export function DocumentLinkToolbar({
  editor,
  url,
  range,
  setToolbarOpen,
  setToolbarPositionFrozen,
}: LinkToolbarProps & { editor: ViewedEditor }): React.JSX.Element {
  const [face, setFace] = React.useState<ToolbarFace>('read');
  const [draft, setDraft] = React.useState('');
  const [showInvalid, setShowInvalid] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const held = React.useRef<TrackedLink | null>(null);
  const owedClose = React.useRef(false);
  const borrowed = React.useRef<{
    reader: HeldPoint;
    planted: HeldPoint;
  } | null>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  /**
   * Give the editor back the caret and the focus the field took from it.
   *
   * Opening the field takes both: the caret moves into the link so the
   * controller keeps answering about it, and the field itself takes the focus
   * so the address can be typed. Neither comes back on its own, and an editor
   * left unfocused with a caret it did not put there is worse than it sounds:
   * ProseMirror only reads the browser's selection back while it has the focus
   * (`hasFocusAndSelection`, `domobserver.ts`), so the next press in the body
   * moves the visible caret and NOT the editor's — measured, the state stayed
   * where the field had put it through nine further presses, which leaves the
   * next thing typed landing inside the link instead of where it was aimed.
   * The link toolbar goes with it: the controller reads the caret first, and
   * a caret stuck inside a link switches the pointer route off entirely
   * (`LinkToolbarController.tsx:83-85,152`).
   */
  const returnCaret = React.useCallback((): void => {
    const borrow = borrowed.current;
    borrowed.current = null;
    if (borrow === null) return;
    const state = editor.prosemirrorState;
    const { from, to } = state.selection;
    // Only while nobody has moved it since. A reader who went on to press
    // somewhere else, or to select something, keeps what they did — and that
    // is reachable from the address face, which the field steps back to on
    // Escape and after a confirm while the toolbar stays up.
    if (from !== to || from !== pointNow(state, borrow.planted)) return;
    const reader = pointNow(state, borrow.reader);
    editor.transact((tr) => {
      tr.setSelection(
        TextSelection.near(
          tr.doc.resolve(Math.min(reader, tr.doc.content.size)),
        ),
      );
    });
    viewOf(editor)?.focus();
  }, [editor]);

  /**
   * Put the toolbar back to the address, writing nothing.
   *
   * The focus comes back here: the field took it to be typed into and is being
   * removed, and a removed focused element drops the focus on the body, where
   * ProseMirror stops reading the browser's selection back. The caret stays in
   * the link — the toolbar is still on screen over it, which is the state a
   * caret inside a link is supposed to produce. What it is owed is settled
   * whenever the toolbar itself goes.
   */
  const backToRead = React.useCallback((): void => {
    setFace('read');
    setDraft('');
    setShowInvalid(false);
    held.current = null;
    setToolbarPositionFrozen?.(false);
    viewOf(editor)?.focus();
  }, [editor, setToolbarPositionFrozen]);

  /**
   * Swap the address for the field, and draw the link it acts on.
   *
   * The caret goes into the link, because from here on that is where the
   * reader is working — and the controller reads the caret for everything it
   * does next. It re-asks `getLinkAtSelection` on every document change,
   * a co-editor's included (`LinkToolbarController.tsx:52-62`), so a caret
   * anywhere else takes the toolbar off the screen the moment anything is
   * written; and it stands its pointer handler down only for a link the caret
   * found (`:83-85`), so a caret anywhere else lets the pointer crossing
   * another link carry the toolbar over to it.
   *
   * Collapsed, one character in: `getLinkAtSelection` answers with nothing for
   * any selection that is not empty
   * (`@blocknote/core/src/extensions/LinkToolbar/LinkToolbar.ts:41`), and the
   * boundaries themselves are outside the link as far as it is concerned — the
   * mark is declared `inclusive: false` (`.../Link/link.ts:74`), so
   * `$pos.marks()` drops it at either end.
   *
   * The link is taken hold of as well, so that what the field writes is
   * settled here rather than read back off props at confirm time.
   */
  const startEdit = React.useCallback((): void => {
    const state = editor.prosemirrorState;
    const planted = range.from + 1;
    held.current = trackLink(state, range);
    // Taken once for the life of the toolbar: the field can be entered again
    // from the address face, and by then the caret is the one this borrow
    // already moved.
    borrowed.current ??= {
      reader: holdPoint(state, state.selection.from),
      planted: holdPoint(state, planted),
    };
    editor.transact((tr) => {
      tr.setSelection(TextSelection.create(tr.doc, planted));
    });
    setDraft(url);
    setShowInvalid(false);
    setFace('form');
    owedClose.current = true;
    setToolbarPositionFrozen?.(true);
  }, [editor, range, setToolbarPositionFrozen, url]);

  /**
   * Write what is in the field onto the link this toolbar opened over.
   *
   * The handle resolves to a span, and the link inside that span is what gets
   * the address: the handle's end names the character that followed the link
   * when it was taken, so text a peer wrote at that boundary sits inside the
   * span carrying no link of its own. An editor bound to no shared document
   * takes no handle, and the controller's own range is then the link.
   *
   * The write is a document change, and the controller answers one by asking
   * again what link the selection is on. The caret is inside this link, put
   * there when the field opened, so it finds this one and the toolbar comes
   * back to the address face showing what was just written.
   */
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    const target = held.current
      ? resolveTrackedLink(editor.prosemirrorState, held.current).range
      : resolveLinkInSpan(editor.prosemirrorState, range.from, range.to).range;
    if (target) applyLink(editor, target, normalizeLinkUrl(draft));
    backToRead();
  }, [backToRead, draft, editor, range]);

  /** Take the toolbar off the screen, releasing everything it was holding. */
  const closeToolbar = React.useCallback((): void => {
    owedClose.current = false;
    // Through the address face: what the field held goes with the field,
    // whether or not the controller answers the close being asked for.
    backToRead();
    returnCaret();
    setToolbarOpen?.(false);
  }, [backToRead, returnCaret, setToolbarOpen]);

  /**
   * Take the link off, and let the controller put the toolbar away.
   *
   * The range comes from the controller, which resolved it for the face this
   * press sits on.
   */
  const unlink = React.useCallback((): void => {
    removeLink(editor, range);
    closeToolbar();
  }, [closeToolbar, editor, range]);

  /** Take what was typed, and drop any refusal the last address earned. */
  const changeDraft = React.useCallback((next: string): void => {
    setDraft(next);
    setShowInvalid(false);
  }, []);

  // Entering the field hands it the focus with its contents selected, so the
  // address can be replaced by typing.
  React.useEffect(() => {
    if (face !== 'form') return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [face]);

  // The link is drawn as selected for exactly as long as the field is on
  // screen, however the field leaves: a confirm, Escape, a press outside, or
  // the controller taking the toolbar away from under it. The handle is taken
  // before the face changes, so it is there by the time this runs.
  React.useEffect(() => {
    if (face !== 'form') return undefined;
    showLinkEditSpan(viewOf(editor), held.current);
    return () => {
      showLinkEditSpan(viewOf(editor), null);
    };
  }, [editor, face]);

  // Escape steps back one face. The controller's own dismiss cannot do it:
  // while the position is frozen, its `onOpenChange` returns before it reads
  // the reason (`LinkToolbarController.tsx:124-127`).
  React.useEffect(() => {
    if (face !== 'form') return undefined;
    /**
     * Step back one face on Escape.
     * @param event - The key press.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      backToRead();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [backToRead, face]);

  // A press outside puts the toolbar away. The controller cannot do this one:
  // while the position is frozen its `onOpenChange` returns before it reads
  // the reason (`LinkToolbarController.tsx:124-127`), so floating-ui's
  // outside-press dismissal is dropped — and `useHover` fires its close once
  // when the pointer leaves, so unfreezing later does not make it try again.
  //
  // On `pointerdown` rather than `click`: pressing inside the body moves the
  // caret, and the caret is what the controller reads, so waiting for the
  // release would let it answer about wherever the press landed first.
  React.useEffect(() => {
    if (face !== 'form') return undefined;
    /**
     * Put the toolbar away for a press that lands outside it.
     * @param event - The press.
     */
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && shellRef.current?.contains(target)) return;
      closeToolbar();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [closeToolbar, face]);

  // The drawn link goes away with the toolbar, however it closes. So do the
  // freeze and the open state, once the field has been opened: from that point
  // the controller is owed a close it was prevented from making. It drops the
  // link it holds the moment the caret leaves it, which unmounts this component
  // without passing through remove, and while the freeze stood it both skipped
  // the close it wanted (`LinkToolbarController.tsx:57-59`) and returned from
  // `onOpenChange` before it read the reason (`:124-127`). Left open with no
  // link, it raises the toolbar over the next link the pointer touches with no
  // open delay at all.
  //
  // The flag is also what keeps this off the controller on the way in:
  // StrictMode runs the teardown once right after the first mount
  // (`index.tsx:47`), and writing the open state there would close the toolbar
  // in the frame it opened.
  React.useEffect(
    () => () => {
      if (!owedClose.current) return;
      owedClose.current = false;
      returnCaret();
      setToolbarPositionFrozen?.(false);
      setToolbarOpen?.(false);
    },
    [editor, returnCaret, setToolbarOpen, setToolbarPositionFrozen],
  );

  return (
    <div
      ref={shellRef}
      data-testid='doc-link-toolbar'
      className={LINK_PANEL_SURFACE}
    >
      {face === 'read' ? (
        <DocumentLinkRead href={url} onEdit={startEdit} onRemove={unlink} />
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
  );
}
