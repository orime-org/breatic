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
import { ShowSelectionExtension } from '@blocknote/core/extensions';
import { TextSelection } from '@tiptap/pm/state';

import { DocumentLinkRead } from '@web/spaces/document/DocumentLinkRead';
import { DocumentLinkForm } from '@web/spaces/document/DocumentLinkForm';
import {
  applyLink,
  removeLink,
  normalizeLinkUrl,
  isLinkUrlShaped,
} from '@web/spaces/document/document-link';
import type { ViewedEditor } from '@web/spaces/document/document-editor-view';

/**
 * Our name in the extension's set of callers asking for the selection to be
 * drawn.
 *
 * Its own key, separate from the panel's: the two can never show at once, but
 * a shared key would let whichever closed last take away a mark the other had
 * just asked for.
 */
const SELECTION_MARK_KEY = 'documentLinkToolbar';

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

  /**
   * Ask for the link to be drawn as selected, or stop asking.
   * @param on - True while the field is showing.
   */
  const markLink = React.useCallback(
    (on: boolean): void => {
      editor.getExtension(ShowSelectionExtension)?.showSelection(
        on,
        SELECTION_MARK_KEY,
      );
    },
    [editor],
  );

  /** Put the toolbar back to the address, writing nothing. */
  const backToRead = React.useCallback((): void => {
    setFace('read');
    setDraft('');
    setShowInvalid(false);
    markLink(false);
    setToolbarPositionFrozen?.(false);
  }, [markLink, setToolbarPositionFrozen]);

  /**
   * Swap the address for the field.
   *
   * The document selection goes onto the link first. The extension draws
   * whatever the selection covers, and the two ways into this toolbar leave it
   * elsewhere — hovering does not move it at all, and the caret route leaves it
   * collapsed inside the link, which has no width to draw.
   */
  const startEdit = React.useCallback((): void => {
    editor.exec((state, dispatch) => {
      dispatch?.(
        state.tr.setSelection(
          TextSelection.create(state.doc, range.from, range.to),
        ),
      );
      return true;
    });
    setDraft(url);
    setShowInvalid(false);
    setFace('form');
    markLink(true);
    setToolbarPositionFrozen?.(true);
  }, [editor, markLink, range.from, range.to, setToolbarPositionFrozen, url]);

  /** Write what is in the field onto the link this toolbar opened over. */
  const submit = React.useCallback((): void => {
    if (!isLinkUrlShaped(draft)) {
      setShowInvalid(true);
      return;
    }
    applyLink(editor, range, normalizeLinkUrl(draft));
    backToRead();
  }, [backToRead, draft, editor, range]);

  /** Take the link off, and let the controller put the toolbar away. */
  const unlink = React.useCallback((): void => {
    removeLink(editor, range);
    markLink(false);
    setToolbarPositionFrozen?.(false);
    setToolbarOpen?.(false);
  }, [editor, markLink, range, setToolbarOpen, setToolbarPositionFrozen]);

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

  // The mark goes away with the toolbar, however it closes.
  React.useEffect(
    () => () => {
      markLink(false);
    },
    [markLink],
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
