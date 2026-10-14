// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The file picker behind the insert menu's media entries (inner#1127 A1,
 * inner#1351 + inner#1390 design §5.9).
 *
 * A pick opens the system picker filtered to that kind. Once files are
 * chosen, the admitted ones become pending blocks, put in where the entry
 * says as one undo step, and their uploads start. Closing the picker without
 * a file, or choosing only files that are refused, leaves the document as it
 * was.
 */

import * as React from 'react';

import { uploadAcceptFor } from '@web/spaces/canvas/canvas-upload';
import type { FileUploads, PendingBlock } from '@web/spaces/document/document-uploads';
import type { MediaBlockType } from '@web/spaces/document/document-media-types';

/**
 * Puts the chosen files' blocks in.
 * @returns False when the row the menu was opened on is gone, and nothing went in.
 */
type MediaPlace = (blocks: readonly PendingBlock[]) => boolean;

/** Opens the picker for a kind; `place` puts the blocks in once files are chosen. */
type MediaPick = (kind: MediaBlockType, place: MediaPlace) => void;

const MediaPickContext = React.createContext<MediaPick | null>(null);

/**
 * The pick the nearest picker offers, or null where there is none (a viewer).
 * @returns The pick.
 */
export function useDocumentMediaPick(): MediaPick | null {
  return React.useContext(MediaPickContext);
}

interface DocumentMediaPickerProps {
  /** What admits chosen files; null where nothing may be picked (a viewer). */
  files: FileUploads | null;
  children: React.ReactNode;
}

/**
 * Provides the pick, and the hidden input it opens. Without file admission it
 * provides none, around the same children, so a reader turning read-only
 * keeps the body mounted where it is.
 * @param props - See {@link DocumentMediaPickerProps}.
 * @param props.files - What admits chosen files.
 * @param props.children - What may pick.
 * @returns The provider and the input.
 */
export function DocumentMediaPicker({ files, children }: DocumentMediaPickerProps): React.JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  const pending = React.useRef<MediaPlace | null>(null);

  const pick = React.useCallback<MediaPick>((kind, place) => {
    const element = input.current;
    if (element === null) return;
    pending.current = place;
    element.accept = uploadAcceptFor(kind);
    // Cleared so picking the same file twice still reports a change.
    element.value = '';
    element.click();
  }, []);

  const onChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const chosen = Array.from(event.target.files ?? []);
      const place = pending.current;
      pending.current = null;
      if (chosen.length === 0 || place === null || files === null) return;
      const prepared = files.prepare(chosen);
      if (prepared === null) return;
      if (place(prepared.blocks)) prepared.start();
    },
    [files],
  );

  return (
    <MediaPickContext.Provider value={files === null ? null : pick}>
      {children}
      {files !== null && (
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
