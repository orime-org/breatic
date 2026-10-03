// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The button on the top-right corner of the cell the caret is in (inner#1126
 * A10, A11), and its menu: the cell's alignment, its fill, and splitting a
 * merged cell.
 *
 * It follows the caret rather than the pointer, so it is ours rather than the
 * library's cell handle, which answers to where the pointer is. It steps aside
 * for a selection, as the handles do; a selection over cells is served by the
 * bubble bar.
 */

import {
  autoUpdate,
  FloatingPortal,
  hide,
  offset,
  useFloating,
} from '@floating-ui/react';
import { cellAround } from '@tiptap/pm/tables';
import type { EditorState } from '@tiptap/pm/state';
import { ChevronDown, TableCellsSplit } from 'lucide-react';
import * as React from 'react';

import { Button } from '@web/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { useTranslation } from '@web/i18n/use-translation';
import { itemWithin } from '@web/spaces/document/document-block-menu-parts';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import {
  CellAttributeMenus,
  onTargetCell,
  useCloseWhenTargetGone,
} from '@web/spaces/document/document-table-menu-parts';
import { isMerged, splitCellAt } from '@web/spaces/document/document-table-run';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** The button's side, and its inset from the cell's top-right corner. */
const BUTTON = 20;
const INSET = 2;

interface DocumentTableCellButtonProps {
  /** The editor. */
  readonly editor: HandleEditor;
  /** Where the button is drawn. */
  readonly viewport: HTMLElement;
}

/**
 * The cell the caret stands in, while the selection is a caret.
 * @param state - The editor state.
 * @returns The position before the cell, or null.
 */
function caretCellOf(state: EditorState): number | null {
  if (!state.selection.empty) return null;
  return cellAround(state.selection.$head)?.pos ?? null;
}

/**
 * The cell button.
 * @param props - See {@link DocumentTableCellButtonProps}.
 * @param props.editor - The editor.
 * @param props.viewport - Where the button is drawn.
 * @returns The button, or null while the caret is in no cell.
 */
export function DocumentTableCellButton({
  editor,
  viewport,
}: DocumentTableCellButtonProps): React.JSX.Element | null {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  const caretCell = useEditorSnapshot(
    editor as never,
    (current: { prosemirrorState: EditorState }) => caretCellOf(current.prosemirrorState),
  );
  // While the menu is open the button stays on the cell it was opened on,
  // followed through edits; the caret does not move while the focus is in
  // the menu, but someone else's edit can move the cell.
  const heldCell = useEditorSnapshot(
    editor as never,
    (current: { prosemirrorState: EditorState }) => tableTargetOf(current.prosemirrorState),
  );
  const cellPos = open ? heldCell : caretCell;
  const merged = useEditorSnapshot(
    editor as never,
    (current: { prosemirrorState: EditorState }) =>
      cellPos !== null && isMerged(current.prosemirrorState.doc, cellPos),
  );

  // `hide` reads the cell's clipping ancestors, the table's scroll frame among
  // them: a cell scrolled out of the frame takes its button with it.
  const { refs, floatingStyles, middlewareData } = useFloating({
    placement: 'top-end',
    middleware: [offset({ mainAxis: -(BUTTON + INSET), crossAxis: -INSET }), hide()],
    whileElementsMounted: autoUpdate,
  });
  const hidden = middlewareData.hide?.referenceHidden === true;
  const style = React.useMemo<React.CSSProperties>(
    () => (hidden ? { ...floatingStyles, visibility: 'hidden' } : floatingStyles),
    [floatingStyles, hidden],
  );

  React.useLayoutEffect(() => {
    const view = editor.prosemirrorView;
    const element = cellPos === null || view === undefined ? null : view.nodeDOM(cellPos);
    refs.setReference(element instanceof Element ? element : null);
  }, [cellPos, editor, refs]);

  const onOpenChange = React.useCallback(
    (next: boolean): void => {
      const view = editor.prosemirrorView;
      if (view === undefined) return;
      if (next) {
        const pos = caretCellOf(view.state);
        if (pos === null) return;
        setTableTarget(view, pos);
      } else {
        setTableTarget(view, null);
      }
      setOpen(next);
    },
    [editor],
  );
  const close = React.useCallback((): void => {
    onOpenChange(false);
  }, [onOpenChange]);
  useCloseWhenTargetGone(editor, open, close);

  if (cellPos === null) return null;

  return (
    <FloatingPortal root={viewport}>
      <div ref={refs.setFloating} style={style}>
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
          <div className='relative flex'>
            {/* The anchor, and nothing else, as on the handles. */}
            <DropdownMenuTrigger asChild>
              <span aria-hidden className='pointer-events-none absolute inset-0' />
            </DropdownMenuTrigger>
            <Button
              variant={null}
              size={null}
              aria-label={t('spaces.document.table.cellMenu')}
              data-testid='doc-table-cell-button'
              className='flex size-5 items-center justify-center rounded-chrome-sm border border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3'
              // The caret stays where the reader left it: a press here does not
              // take the focus from the body.
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                onOpenChange(!open);
              }}
            >
              <ChevronDown />
            </Button>
          </div>
          <DropdownMenuContent
            side='bottom'
            align='end'
            rowsClassName='flex flex-col gap-1'
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              editor.focus();
            }}
          >
            {open ? (
              <>
                <CellAttributeMenus editor={editor} scope='cell' stem='doc-table-cell-' />
                <DropdownMenuSeparator className='my-0' />
                <DropdownMenuItem
                  data-testid='doc-table-cell-split'
                  {...itemWithin(merged, () => {
                    onTargetCell(editor, (pos) => {
                      splitCellAt(editor, pos);
                    });
                  })}
                >
                  <TableCellsSplit />
                  {t('spaces.document.table.splitCell')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </FloatingPortal>
  );
}
