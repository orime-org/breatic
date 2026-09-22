// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The strip that hangs off the row under the pointer.
 *
 * It is BlockNote's side menu controller given our own component in place of
 * the library's, because the handle's icon and its two gestures are ours (see
 * `DocumentBlockHandle`). No `ComponentsContext` is provided: the only
 * components that read it are the defaults we replaced, so on this path
 * nothing asks for it.
 *
 * `BlockNoteContext` IS needed — `SideMenuController` renders `<Component />`
 * with no props (`SideMenuController.tsx:157`), so the strip reaches the
 * editor through `useBlockNoteEditor`, which reads this context.
 */

import { BlockNoteContext, SideMenuController } from '@blocknote/react';
import * as React from 'react';

import { DocumentBlockHandle } from '@web/spaces/document/DocumentBlockHandle';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { NO_LIBRARY_OFFSET } from '@web/spaces/document/document-strip-alignment';

interface DocumentBlockControlsProps {
  /** The editor the strip acts on. */
  editor: HandleEditor;
}

/**
 * Mounts the strip under the context it needs.
 * @param props - See {@link DocumentBlockControlsProps}.
 * @param props.editor - The editor the strip acts on.
 * @returns The controller.
 */
export function DocumentBlockControls({
  editor,
}: DocumentBlockControlsProps): React.JSX.Element {
  // The editor type here is ours (`BlockNoteEditor<never, never, never>`)
  // while the context's is pinned to the library's own default schema; the
  // library holds its own value as `any` for the same reason.
  const context = React.useMemo(
    () => ({ editor, setContentEditableProps: () => undefined }),
    [editor],
  ) as never;

  return (
    <BlockNoteContext.Provider value={context}>
      <SideMenuController
        sideMenu={DocumentBlockHandle}
        floatingUIOptions={NO_LIBRARY_OFFSET}
      />
    </BlockNoteContext.Provider>
  );
}
