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
  detectOverflow,
  FloatingPortal,
  useFloating,
  type Middleware,
} from '@floating-ui/react';
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
import { caretCellOf, cellButtonBox } from '@web/spaces/document/document-table-control-place';
import { isMerged, splitCellAt } from '@web/spaces/document/document-table-run';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/**
 * Puts the button on the top-right corner of the part of its cell the reader
 * can see. The cell's clipping ancestors — the table's scroll frame, the
 * body's scroll area — can cut it; the button follows the cut edge in, and is
 * hidden when the visible part has no room for it.
 */
const onVisibleCorner: Middleware = {
  name: 'onVisibleCorner',
  /**
   * Places the button.
   * @param state - floating-ui's state for this pass.
   * @returns The button's position, and whether it is hidden.
   */
  async fn(state) {
    const cut = await detectOverflow(state, { elementContext: 'reference' });
    const { x, y, width, height } = state.rects.reference;
    const place = cellButtonBox({
      left: x + Math.max(0, cut.left),
      top: y + Math.max(0, cut.top),
      right: x + width - Math.max(0, cut.right),
      bottom: y + height - Math.max(0, cut.bottom),
    });
    return place === null ? { data: { hidden: true } } : { x: place.left, y: place.top, data: { hidden: false } };
  },
};

interface DocumentTableCellButtonProps {
  /** The editor. */
  readonly editor: HandleEditor;
  /** Where the button is drawn. */
  readonly viewport: HTMLElement;
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

  // The cell's element as it is after every change: ProseMirror draws a cell
  // anew when its attributes change (alignment, fill, width, a split), so an
  // element read once would go on measuring one no longer in the page.
  const cellElement = useEditorSnapshot(
    editor as never,
    (current: { prosemirrorView: { nodeDOM: (pos: number) => Node | null } | undefined }) => {
      const element = cellPos === null ? null : current.prosemirrorView?.nodeDOM(cellPos);
      return element instanceof Element ? element : null;
    },
  );
  const { refs, floatingStyles, middlewareData } = useFloating({
    middleware: [onVisibleCorner],
    whileElementsMounted: autoUpdate,
  });
  // The reference is handed over on every change. @floating-ui/react 0.27.20
  // holds the first `elements.reference` it receives in state for the hook's
  // whole life (`useFloatingRootContext`), and a Space reopened from its tab
  // hands back its editor with the caret already in a cell.
  React.useLayoutEffect(() => {
    refs.setReference(cellElement);
  }, [refs, cellElement]);
  const hidden = (middlewareData.onVisibleCorner as { hidden?: boolean } | undefined)?.hidden === true;
  const style = React.useMemo<React.CSSProperties>(
    () => (hidden ? { ...floatingStyles, visibility: 'hidden' } : floatingStyles),
    [floatingStyles, hidden],
  );

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
              variant='chrome-ghost'
              size={null}
              aria-label={t('spaces.document.table.cellMenu')}
              data-testid='doc-table-cell-button'
              className='flex size-5 items-center justify-center rounded-chrome-sm border border-border bg-popover [&_svg]:size-3'
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
