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
import { BlockNoteContext, SideMenuController, SuggestionMenuController, useExtensionState } from '@blocknote/react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { DocumentBlockHandle } from '@web/spaces/document/DocumentBlockHandle';
import {
  DocumentInsertMenu,
  filterInsertItems,
  insertMenuItems,
  type InsertMenuItem,
} from '@web/spaces/document/DocumentInsertMenu';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { NO_LIBRARY_OFFSET } from '@web/spaces/document/document-strip-alignment';
import { INSERT_TRIGGER } from '@web/spaces/document/document-insert-menu-items';
import { withdrawInsert, type InsertEditor } from '@web/spaces/document/document-insert-row';
import {
  endInsert,
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
 * Puts the row back when the insert menu closes with nothing chosen.
 *
 * Dismissal has no event of its own, so what this watches is the menu's own
 * state going from shown to not shown. A session still in the ref at that
 * moment is one nobody chose from — choosing clears it — and the row the plus
 * made for it goes back out (A14), along with the trigger character and
 * whatever was typed into the menu — all three are document text, and
 * `withdrawInsert` takes them out by addressing that one block.
 *
 * Deliberately NOT the menu component's unmount: React unmounts and remounts
 * on its own — StrictMode does it to every component in development — and
 * measured, that took the row away the instant the menu opened, before anyone
 * could choose anything.
 * @param editor - The editor to write to.
 * @param session - The insert the plus has under way.
 */
function useWithdrawOnDismiss(editor: InsertEditor, session: ReturnType<typeof useInsertSession>): void {
  // The hooks take the library's own editor type; ours is the same object
  // with a narrower schema, which is why both need the cast the library makes
  // internally.
  const held = editor as never;
  const state = useExtensionState(SuggestionMenu, {
    editor: held,
    selector: (menu) => ({ shown: menu?.show === true, query: menu?.query }),
  });
  const shown = state?.shown === true;
  const query = state?.query;
  const wasShown = React.useRef(false);
  // The query is kept while the menu is OPEN: by the time it closes the
  // plugin has let go of its state, and what the reader typed is the other
  // half of what has to come back out of the document. This effect is
  // declared before the one that withdraws, so on the closing render it has
  // already run — and declines to run, because the menu is no longer shown.
  const typed = React.useRef('');
  React.useEffect(() => {
    if (shown && query !== undefined) typed.current = query;
  }, [shown, query]);

  React.useEffect(() => {
    if (shown) {
      wasShown.current = true;
      return;
    }
    if (!wasShown.current) return;
    wasShown.current = false;

    const pending = endInsert(session);
    if (pending === undefined) return;
    withdrawInsert(editor, pending, typed.current);
    typed.current = '';
  }, [shown, editor, session]);
}

/**
 * Mounts both carriers under the context they need.
 * @param props - See {@link DocumentBlockControlsProps}.
 * @param props.editor - The editor both carriers act on.
 * @returns The two controllers.
 */
export function DocumentBlockControls({ editor }: DocumentBlockControlsProps): React.JSX.Element {
  const t = useTranslation();
  const session = React.useRef<InsertSession | undefined>(undefined);
  useWithdrawOnDismiss(editor, session);

  // The editor type here is ours (`BlockNoteEditor<never, never, never>`)
  // while the context's is pinned to the library's own default schema; the
  // library holds its own value as `any` for the same reason.
  const context = React.useMemo(() => ({ editor, setContentEditableProps: () => undefined }), [editor]) as never;

  // The entries are named on every call rather than once: `useTranslation`
  // hands back the same function object whatever the language is — it
  // re-renders subscribers on a change rather than changing identity — so a
  // list built once and kept keeps the words it was first built with.
  // Measured in the browser: the block handle menu followed the language
  // switch and the insert menu still read "Quote".
  const getItems = React.useCallback(
    async (query: string) => Promise.resolve(filterInsertItems(insertMenuItems(t), query)),
    [t],
  );

  const onItemClick = React.useCallback(
    (item: InsertMenuItem) => {
      const pending = endInsert(session);
      if (pending === undefined) return;
      // An insert sets the kind the reader chose; it never cancels it.
      runBlockType(editor, item.id, pending.blockId, false);
    },
    [editor],
  );

  return (
    <BlockNoteContext.Provider value={context}>
      <InsertSessionContext.Provider value={session}>
        <SideMenuController sideMenu={DocumentBlockHandle} floatingUIOptions={NO_LIBRARY_OFFSET} />
        <SuggestionMenuController
          triggerCharacter={INSERT_TRIGGER}
          shouldOpen={NEVER_ON_TYPING}
          getItems={getItems}
          suggestionMenuComponent={DocumentInsertMenu}
          onItemClick={onItemClick}
        />
      </InsertSessionContext.Provider>
    </BlockNoteContext.Provider>
  );
}
