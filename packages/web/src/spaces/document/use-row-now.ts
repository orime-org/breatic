// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The row a block handle is about, read again by its id each time.
 *
 * The block the side menu hands over is a snapshot taken when the pointer
 * arrived: the library refreshes it on a document change (`SideMenu.ts:683-688`)
 * but `updateStateFromMousePos` returns early while the hovered element still
 * carries the same `data-id` (`:229-236`). A menu stays open however long the
 * reader takes, and a co-editor can change the row or take it away meanwhile,
 * so every command reads it again by the one thing that does not go stale.
 *
 * Measured 2026-09-18: with the snapshot, a row reading `alpha PLUS` on screen
 * was duplicated as `alpha`.
 */

import * as React from 'react';

import type {
  HandleEditor,
  PressedBlock,
} from '@web/spaces/document/document-handle-commands';

/**
 * A reader of the row with this id, as the document holds it at the call.
 * @param editor - The editor holding the row.
 * @param blockId - The row's id; nothing is read while it is undefined.
 * @returns A stable function giving the row, or undefined once it is gone.
 */
export function useRowNow(
  editor: HandleEditor,
  blockId: string | undefined,
): () => PressedBlock | undefined {
  return React.useCallback(
    (): PressedBlock | undefined =>
      blockId === undefined
        ? undefined
        : (editor.getBlock(blockId) as PressedBlock | undefined),
    [editor, blockId],
  );
}
