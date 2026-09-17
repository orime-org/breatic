// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two carriers that hang off a row: the strip beside it, and the list the
 * plus opens.
 *
 * Both are BlockNote controllers, and both are given our own component in
 * place of the library's — the strip because its buttons and gestures are
 * ours (see `DocumentBlockHandle`), the list because its surface and rows are
 * ours (see `DocumentInsertMenu`). That is also why no `ComponentsContext` is
 * provided here: the only components that read it are the two defaults we
 * replaced, so on this path nothing asks for it.
 *
 * `BlockNoteContext` IS needed — `SuggestionMenuWrapper` reads
 * `setContentEditableProps` from it without checking. What it writes there is
 * `aria-expanded` and `aria-controls`, which serve screen readers alone, and
 * this product does not support them (`docs/ACCESSIBILITY.md`), so the sink it
 * is given here keeps them off the editable element rather than putting them
 * on it.
 */

import { SuggestionMenu } from '@blocknote/core/extensions';
import {
  BlockNoteContext,
  SideMenuController,
  SuggestionMenuController,
  useBlockNoteEditor,
  useExtension,
} from '@blocknote/react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { DocumentBlockHandle } from '@web/spaces/document/DocumentBlockHandle';
import {
  DocumentInsertMenu,
  filterInsertItems,
  insertMenuItems,
  type DocumentInsertMenuProps,
  type InsertMenuItem,
} from '@web/spaces/document/DocumentInsertMenu';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { INSERT_TRIGGER } from '@web/spaces/document/document-insert-menu-items';
import {
  withdrawRow,
  type InsertEditor,
} from '@web/spaces/document/document-insert-row';
import {
  InsertSessionContext,
  useInsertSession,
  type InsertSession,
} from '@web/spaces/document/document-insert-session';

interface DocumentBlockControlsProps {
  /** The editor both carriers act on. */
  editor: InsertEditor;
}

/**
 * The menu is registered, never opened by typing (A16).
 * @returns Always false.
 */
const NEVER_ON_TYPING = (): boolean => false;

/**
 * The list, plus what happens to the row when the reader chooses nothing.
 *
 * Dismissal has no event of its own: the menu simply stops being rendered. So
 * the going is what this reads — a session still in the ref at that moment is
 * one nobody chose from, and the row the plus made for it goes back out (A14).
 * Clearing the query comes first, because what the reader typed is document
 * text too and `withdrawRow` keeps any row that holds something.
 * @param props - What the controller hands the list.
 * @returns The list.
 */
function InsertMenuWithWithdraw(
  props: DocumentInsertMenuProps,
): React.JSX.Element {
  const editor = useBlockNoteEditor();
  const suggestionMenu = useExtension(SuggestionMenu);
  const session = useInsertSession();

  React.useEffect(
    () => (): void => {
      const pending = session.current;
      session.current = undefined;
      if (pending === undefined) return;
      suggestionMenu.clearQuery();
      if (pending.made) {
        withdrawRow(editor as InsertEditor, pending.blockId);
      }
    },
    [editor, session, suggestionMenu],
  );

  return <DocumentInsertMenu {...props} />;
}

/**
 * Mounts both carriers under the context they need.
 * @param props - See {@link DocumentBlockControlsProps}.
 * @param props.editor - The editor both carriers act on.
 * @returns The two controllers.
 */
export function DocumentBlockControls({
  editor,
}: DocumentBlockControlsProps): React.JSX.Element {
  const t = useTranslation();
  const session = React.useRef<InsertSession | undefined>(undefined);

  // The editor type here is ours (`BlockNoteEditor<never, never, never>`)
  // while the context's is pinned to the library's own default schema; the
  // library holds its own value as `any` for the same reason.
  const context = React.useMemo(
    () => ({ editor, setContentEditableProps: () => undefined }),
    [editor],
  ) as never;

  const items = React.useMemo(() => insertMenuItems(t), [t]);

  const getItems = React.useCallback(
    async (query: string) => Promise.resolve(filterInsertItems(items, query)),
    [items],
  );

  const onItemClick = React.useCallback(
    (item: InsertMenuItem) => {
      const pending = session.current;
      session.current = undefined;
      if (pending === undefined) return;
      runBlockType(editor, item.id, pending.blockId);
    },
    [editor],
  );

  return (
    <BlockNoteContext.Provider value={context}>
      <InsertSessionContext.Provider value={session}>
        <SideMenuController sideMenu={DocumentBlockHandle} />
        <SuggestionMenuController
          triggerCharacter={INSERT_TRIGGER}
          shouldOpen={NEVER_ON_TYPING}
          getItems={getItems}
          suggestionMenuComponent={InsertMenuWithWithdraw}
          onItemClick={onItemClick}
        />
      </InsertSessionContext.Provider>
    </BlockNoteContext.Provider>
  );
}
