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

import { DocumentLinkRead } from '@web/spaces/document/DocumentLinkRead';
import { DocumentLinkForm } from '@web/spaces/document/DocumentLinkForm';
import { showLinkEditSpan } from '@web/spaces/document/document-link-edit-mark';
import {
  trackLink,
  resolveTrackedSpan,
  type TrackedLink,
} from '@web/spaces/document/document-link-tracking';
import {
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
  resolveLinkInSpan,
} from '@web/spaces/document/document-link';
import type { ViewedEditor } from '@web/spaces/document/document-editor-view';

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

  /** Put the toolbar back to the address, writing nothing. */
  const backToRead = React.useCallback((): void => {
    setFace('read');
    setDraft('');
    setShowInvalid(false);
    held.current = null;
    showLinkEditSpan(editor.prosemirrorView, null);
    setToolbarPositionFrozen?.(false);
  }, [editor, setToolbarPositionFrozen]);

  /**
   * Swap the address for the field, and draw the link it acts on.
   *
   * The link is taken hold of here, because from here on it is the link the
   * field is about — and the controller goes on replacing `url` and `range` in
   * place, with a pointer that travels onto another link
   * (`LinkToolbarController.tsx:83-85` only holds off for a link the caret
   * found).
   */
  const startEdit = React.useCallback((): void => {
    held.current = trackLink(editor.prosemirrorState, range);
    setDraft(url);
    setShowInvalid(false);
    setFace('form');
    owedClose.current = true;
    showLinkEditSpan(editor.prosemirrorView, held.current);
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
   * What the reader sees next is the controller's to decide: the write is a
   * document change, and the controller answers one by asking again what link
   * the selection is on. A caret inside the link gets the address back; a
   * pointer that arrived by hovering, with the caret elsewhere, gets the
   * toolbar put away — which is also what the factory's own form does.
   */
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    const span = held.current
      ? resolveTrackedSpan(editor.prosemirrorState, held.current)
      : range;
    const target = span
      ? resolveLinkInSpan(editor.prosemirrorState, span.from, span.to).range
      : null;
    if (target) applyLink(editor, target, normalizeLinkUrl(draft));
    backToRead();
  }, [backToRead, draft, editor, range]);

  /**
   * Take the link off, and let the controller put the toolbar away.
   *
   * The range comes from the controller, which resolved it for the face this
   * press sits on.
   */
  const unlink = React.useCallback((): void => {
    removeLink(editor, range);
    owedClose.current = false;
    showLinkEditSpan(editor.prosemirrorView, null);
    setToolbarPositionFrozen?.(false);
    setToolbarOpen?.(false);
  }, [editor, range, setToolbarOpen, setToolbarPositionFrozen]);

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
      showLinkEditSpan(editor.prosemirrorView, null);
      if (!owedClose.current) return;
      owedClose.current = false;
      setToolbarPositionFrozen?.(false);
      setToolbarOpen?.(false);
    },
    [editor, setToolbarOpen, setToolbarPositionFrozen],
  );

  return (
    <div
      data-testid='doc-link-toolbar'
      className='z-50 w-auto rounded-overlay border border-border bg-popover p-1.5 text-popover-foreground shadow outline-none'
    >
      {face === 'read' ? (
        <DocumentLinkRead href={url} onEdit={startEdit} onRemove={unlink} />
      ) : (
        <DocumentLinkForm
          draft={draft}
          showInvalid={showInvalid}
          canSubmit={isLinkUrlShaped(draft)}
          onDraftChange={changeDraft}
          onSubmit={submit}
          inputRef={inputRef}
        />
      )}
    </div>
  );
}
