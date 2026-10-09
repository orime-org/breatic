// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The file picker behind the insert menu's media entries (inner#1127 A1).
 *
 * A pick opens the system picker filtered to that kind. The gap the files go
 * into is made when files are chosen, not when the entry is pressed: closing
 * the picker without a file leaves the document as it was.
 */

import * as React from 'react';
import type { EditorView } from '@tiptap/pm/view';

import { uploadAcceptFor } from '@web/spaces/canvas/canvas-upload';
import type { MediaGap } from '@web/spaces/document/document-insert-row';
import type { DocumentUploader } from '@web/spaces/document/document-uploads';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/** Opens the picker for a kind; `gap` makes the gap once files are chosen. */
type MediaPick = (kind: MediaBlockType, gap: () => MediaGap | null) => void;

const MediaPickContext = React.createContext<MediaPick | null>(null);

/**
 * The pick the nearest picker offers, or null where there is none (a viewer).
 * @returns The pick.
 */
export function useDocumentMediaPick(): MediaPick | null {
  return React.useContext(MediaPickContext);
}

interface DocumentMediaPickerProps {
  /** Where chosen files go; null where nothing may be picked (a viewer). */
  uploader: DocumentUploader | null;
  /** The editor's view, read when files are chosen. */
  view: () => EditorView | null;
  children: React.ReactNode;
}

/**
 * Provides the pick, and the hidden input it opens. Without an uploader it
 * provides none, around the same children, so a reader turning read-only
 * keeps the body mounted where it is.
 * @param props - See {@link DocumentMediaPickerProps}.
 * @param props.uploader - Where chosen files go.
 * @param props.view - The editor's view.
 * @param props.children - What may pick.
 * @returns The provider and the input.
 */
export function DocumentMediaPicker({
  uploader,
  view,
  children,
}: DocumentMediaPickerProps): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  const pending = React.useRef<(() => MediaGap | null) | null>(null);

  const pick = React.useCallback<MediaPick>((kind, gap) => {
    const element = input.current;
    if (element === null) return;
    pending.current = gap;
    element.accept = uploadAcceptFor(kind);
    // Cleared so picking the same file twice still reports a change.
    element.value = '';
    element.click();
  }, []);

  const onChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target.files ?? []);
      const makeGap = pending.current;
      pending.current = null;
      const target = view();
      if (files.length === 0 || makeGap === null || target === null) return;
      // The gap is made only once a file is admitted.
      void uploader?.start(target, files, makeGap);
    },
    [uploader, view],
  );

  return (
    <MediaPickContext.Provider value={uploader === null ? null : pick}>
      {children}
      {uploader !== null && (
        <input
          ref={input}
          type='file'
          multiple
          className='hidden'
          aria-hidden='true'
          tabIndex={-1}
          data-testid='doc-media-file-input'
          onChange={onChange}
        />
      )}
    </MediaPickContext.Provider>
  );
}
