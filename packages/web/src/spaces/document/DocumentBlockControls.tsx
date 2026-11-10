// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * with no props (`SideMenuController.tsx:165`), so the strip reaches the
 * editor through `useBlockNoteEditor`, which reads this context.
 */

import { BlockNoteContext, SideMenuController } from '@blocknote/react';
import * as React from 'react';

import { DocumentBlockHandle } from '@web/spaces/document/DocumentBlockHandle';
import { DocumentTableHandlesController } from '@web/spaces/document/DocumentTableHandlesController';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { stripPlacement } from '@web/spaces/document/document-strip-alignment';
import { domElementOf } from '@web/spaces/document/document-editor-view';
import { useTableFullscreen } from '@web/spaces/document/use-table-fullscreen';

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
  const placement = React.useMemo(
    () => stripPlacement(() => domElementOf(editor) ?? undefined),
    [editor],
  );

  // A table open full screen has no block handles in its cells: their menu
  // and drag act on blocks of the body (#1427 §5.1).
  const fullscreen = useTableFullscreen(editor).table !== null;

  return (
    <BlockNoteContext.Provider value={context}>
      {fullscreen ? null : (
        <SideMenuController
          sideMenu={DocumentBlockHandle}
          floatingUIOptions={placement}
        />
      )}
      {/* A table's row and column handles (inner#1126 §5.0). */}
      <DocumentTableHandlesController editor={editor} />
    </BlockNoteContext.Provider>
  );
}
