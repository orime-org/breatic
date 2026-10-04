// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A table's row and column handles (inner#1126 A6), handed to the library's
 * `TableHandlesController` in place of its own, which read a
 * `ComponentsContext` this build does not provide.
 *
 * The controller places them and reports which row and column the pointer is
 * over; everything else is ours. A handle's menu acts on the cell the menu
 * was opened on, held in `document-table-target.ts` and mapped through every
 * change while the menu is open, so an edit someone else makes above the
 * table cannot point a command at another row. The library's own table
 * position is written on pointer moves only and goes stale under such an edit,
 * so no command reads it.
 *
 * Neither is on screen while the reader holds a selection: the
 * bubble bar serves a selection, the way the block handle steps aside for it.
 */

import { TableHandlesExtension } from '@blocknote/core/extensions';
import {
  useBlockNoteEditor,
  useExtension,
  useExtensionState,
} from '@blocknote/react';
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  GripHorizontal,
  GripVertical,
  PanelLeft,
  PanelTop,
} from 'lucide-react';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
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
import { BLOCK_MENU_ROWS } from '@web/spaces/document/document-block-menu-rows';
import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { MenuTick } from '@web/spaces/document/document-menu-tick';
import {
  cellAt,
  cellPosOf,
  deleteColumnAt,
  deleteRowAt,
  headerOn,
  insertColumn,
  insertRow,
  toggleHeaderAt,
} from '@web/spaces/document/document-table-run';
import {
  CellAttributeMenus,
  onTargetCell,
  useCloseWhenTargetGone,
  useHoldsSelection,
} from '@web/spaces/document/document-table-menu-parts';
import {
  caretCellOf,
  cellButtonBox,
  columnHandleCentre,
  COLUMN_HANDLE_NUDGE,
  ROW_HANDLE_NUDGE,
  type Box,
} from '@web/spaces/document/document-table-control-place';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';
import { endTableDrag, startTableDrag } from '@web/spaces/document/document-table-drag';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** What the library's handle state carries, as far as these read it. */
interface HandlesState {
  readonly show: boolean;
  readonly block: { readonly id: string };
  readonly rowIndex: number | undefined;
  readonly colIndex: number | undefined;
  /** The hovered cell's box, read when the handles were last placed. */
  readonly referencePosCell: DOMRect | undefined;
}

/** What the controller hands a handle. */
interface TableHandleProps {
  readonly orientation: 'row' | 'column';
  readonly hideOtherElements: (hide: boolean) => void;
}

/**
 * What a drag off a handle carries: nothing to drop anywhere else, a type of
 * its own so a drop target can tell it from text.
 */
const TABLE_LINE_TYPE = 'application/x-doc-table-line';

/** The delete row's icon, shared with the block handle's menu. */
const DeleteIcon = BLOCK_MENU_ROWS.find((row) => row.id === 'delete')!.Icon;

/** Where a handle is drawn against its table's scroll frame. */
interface FramePlace {
  /** How far the handle moves across, onto the part of the table in view. */
  readonly shift: number;
  /** Whether it is hidden: the part in view has no room for it. */
  readonly hidden: boolean;
}

/** A handle drawn where the controller put it. */
const IN_PLACE: FramePlace = { shift: 0, hidden: false };

/**
 * The cell button's box, when the caret's cell is in this table.
 * @param view - The editor view.
 * @param table - The table.
 * @param frame - The table's scroll frame.
 * @param caretCell - The position before the caret's cell, or null.
 * @returns The box, or null when no button is shown here.
 */
function cellButtonIn(view: EditorView, table: Element, frame: DOMRect, caretCell: number | null): Box | null {
  const cell = caretCell === null ? null : view.nodeDOM(caretCell);
  if (!(cell instanceof Element) || !table.contains(cell)) return null;
  const box = cell.getBoundingClientRect();
  return cellButtonBox({
    left: Math.max(box.left, frame.left),
    top: box.top,
    right: Math.min(box.right, frame.right),
    bottom: box.bottom,
  });
}

/**
 * Where a handle is drawn against the table's scroll frame. The controller
 * places the row handle at the table's own left edge
 * (`TableHandlesController.tsx:108-124`) and the column handle centred over
 * the hovered cell (`:125-141`); on a table scrolled sideways either can lie
 * outside the frame. The row handle moves in by the width scrolled out of it;
 * the column handle moves onto the part of its cell in view, aside from the
 * cell button there (`columnHandleCentre`), and is hidden when that part has
 * no room for it.
 * @param view - The editor view.
 * @param blockId - The table block's id.
 * @param row - Whether this is the row handle.
 * @param cell - The hovered cell's box, as the controller read it, if it has.
 * @param caretCell - The position before the caret's cell, or null.
 * @returns The placement.
 */
function framePlaceOf(
  view: EditorView | undefined,
  blockId: string,
  row: boolean,
  cell: DOMRect | undefined,
  caretCell: number | null,
): FramePlace {
  const table = view?.dom.querySelector(`[data-id="${CSS.escape(blockId)}"] table`);
  const frame = table?.closest('[data-radix-scroll-area-viewport]');
  if (view === undefined || !table || !frame) return IN_PLACE;
  const box = frame.getBoundingClientRect();
  if (row) return { shift: Math.max(0, box.left - table.getBoundingClientRect().left), hidden: false };
  if (cell === undefined) return IN_PLACE;
  const visible = {
    left: Math.max(cell.left, box.left),
    top: cell.top,
    right: Math.min(cell.right, box.right),
    bottom: cell.bottom,
  };
  const x = columnHandleCentre(visible, table.getBoundingClientRect().top, cellButtonIn(view, table, box, caretCell));
  return x === null ? { shift: 0, hidden: true } : { shift: x - (cell.left + cell.width / 2), hidden: false };
}

/** The handle menu's own reading of its target cell. */
interface HeaderFaces {
  /** Whether the header row (or column) applies here: the first one only. */
  readonly reachable: boolean;
  /** Whether it is on. */
  readonly on: boolean;
}

/**
 * The menu rows of one handle.
 * @param props - The editor and the handle's orientation.
 * @param props.editor - The editor.
 * @param props.row - Whether this is the row handle.
 * @returns The rows.
 */
function HandleMenuRows({ editor, row }: { editor: HandleEditor; row: boolean }): React.JSX.Element {
  const t = useTranslation();
  const stem = row ? 'doc-table-row-' : 'doc-table-col-';
  const header = useEditorSnapshot(
    editor as never,
    React.useCallback(
      (current: { prosemirrorState: Parameters<typeof tableTargetOf>[0] }): HeaderFaces | null => {
        const state = current.prosemirrorState;
        const pos = tableTargetOf(state);
        const at = pos === null ? null : cellAt(state.doc, pos);
        if (pos === null || at === null) return null;
        return {
          reachable: row ? at.top === 0 : at.left === 0,
          on: headerOn(state.doc, pos, row ? 'row' : 'column'),
        };
      },
      [row],
    ),
    (a, b) => a === b || (a !== null && b !== null && a.reachable === b.reachable && a.on === b.on),
  );

  if (header === null) return <></>;

  const insertRows = row
    ? ([
      ['insertAbove', 'spaces.document.table.insertRowAbove', ArrowUpToLine, (pos: number) => insertRow(editor, pos, 'above')],
      ['insertBelow', 'spaces.document.table.insertRowBelow', ArrowDownToLine, (pos: number) => insertRow(editor, pos, 'below')],
    ] as const)
    : ([
      ['insertLeft', 'spaces.document.table.insertColumnLeft', ArrowLeftToLine, (pos: number) => insertColumn(editor, pos, 'left')],
      ['insertRight', 'spaces.document.table.insertColumnRight', ArrowRightToLine, (pos: number) => insertColumn(editor, pos, 'right')],
    ] as const);

  return (
    <>
      {insertRows.map(([id, labelKey, Icon, run]) => (
        <DropdownMenuItem
          key={id}
          data-testid={`${stem}${id}`}
          onSelect={() => {
            onTargetCell(editor, run);
          }}
        >
          <Icon />
          {t(labelKey)}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator className='my-0' />
      <DropdownMenuItem
        data-testid={`${stem}header`}
        data-ticked={header.on ? 'true' : undefined}
        {...itemWithin(header.reachable, () => {
          onTargetCell(editor, (pos) => {
            toggleHeaderAt(editor, pos, row ? 'row' : 'column');
          });
        })}
      >
        {row ? <PanelTop /> : <PanelLeft />}
        <span className='flex-1 text-left'>
          {t(row ? 'spaces.document.table.headerRow' : 'spaces.document.table.headerColumn')}
        </span>
        <MenuTick on={header.on} />
      </DropdownMenuItem>
      <CellAttributeMenus editor={editor} scope={row ? 'row' : 'column'} stem={stem} />
      <DropdownMenuSeparator className='my-0' />
      <DropdownMenuItem
        data-testid={`${stem}delete`}
        className='text-status-error-foreground'
        onSelect={() => {
          onTargetCell(editor, (pos) => {
            if (row) deleteRowAt(editor, pos);
            else deleteColumnAt(editor, pos);
          });
        }}
      >
        <DeleteIcon />
        {t(row ? 'spaces.document.table.deleteRow' : 'spaces.document.table.deleteColumn')}
      </DropdownMenuItem>
    </>
  );
}

/**
 * The handle on a row's left edge or a column's top edge, and its menu.
 * @param props - What the controller hands it.
 * @param props.orientation - The row or the column.
 * @param props.hideOtherElements - Hides the controller's other elements.
 * @returns The handle, or null while there is nothing to point at.
 */
export function DocumentTableHandle({
  orientation,
  hideOtherElements,
}: TableHandleProps): React.JSX.Element | null {
  const t = useTranslation();
  const editor = useBlockNoteEditor() as unknown as HandleEditor;
  const handles = useExtension(TableHandlesExtension);
  const state = useExtensionState(TableHandlesExtension) as HandlesState | undefined;
  const holdsSelection = useHoldsSelection(editor);
  const [open, setOpen] = React.useState(false);
  const row = orientation === 'row';

  // What the unmount has to undo, read when it runs: the controller drops a
  // handle whose table was deleted without closing its menu, and the handles
  // stay frozen for every table after it unless this lets them go.
  // Held in a ref and read at unmount, so the cleanup runs once, on unmount,
  // whatever these were last.
  const held = React.useRef({ open: false, hideOtherElements, handles, editor });
  held.current.hideOtherElements = hideOtherElements;
  held.current.handles = handles;
  held.current.editor = editor;
  React.useEffect(
    () => () => {
      const last = held.current;
      if (!last.open) return;
      last.handles.unfreezeHandles();
      last.hideOtherElements(false);
      const view = last.editor.prosemirrorView;
      if (view !== undefined && !view.isDestroyed) setTableTarget(view, null);
    },
    [],
  );

  const onOpenChange = React.useCallback(
    (next: boolean): void => {
      const view = editor.prosemirrorView;
      if (view === undefined) return;
      if (next) {
        if (state?.rowIndex === undefined || state.colIndex === undefined) return;
        const pos = cellPosOf(view.state.doc, state.block.id, state.rowIndex, state.colIndex);
        if (pos === null) return;
        setTableTarget(view, pos, row ? 'row' : 'column');
        handles.freezeHandles();
        hideOtherElements(true);
      } else {
        setTableTarget(view, null);
        handles.unfreezeHandles();
        hideOtherElements(false);
      }
      held.current.open = next;
      setOpen(next);
    },
    [editor, handles, hideOtherElements, row, state],
  );
  const close = React.useCallback((): void => {
    onOpenChange(false);
  }, [onOpenChange]);
  useCloseWhenTargetGone(editor, open, close);

  // Read against the frame whenever the controller places the handles; it
  // hides them on a scroll.
  const caretCell = useEditorSnapshot(
    editor as never,
    (current: { prosemirrorState: EditorState }) => caretCellOf(current.prosemirrorState),
  );
  const placeStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    const place =
      state === undefined
        ? IN_PLACE
        : framePlaceOf(editor.prosemirrorView, state.block.id, row, state.referencePosCell, caretCell);
    if (place.hidden) return { visibility: 'hidden' };
    // Centred on its line: the row handle on the table's left line, the
    // column handle on its top line.
    const across = place.shift + (row ? ROW_HANDLE_NUDGE : 0);
    const up = row ? 0 : COLUMN_HANDLE_NUDGE;
    return { transform: `translate(${String(across)}px, ${String(up)}px)` };
  }, [editor, row, state, caretCell]);

  if (state === undefined || (holdsSelection && !open)) return null;
  const index = row ? state.rowIndex : state.colIndex;
  if (index === undefined) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <div className='doc-table-handle relative flex' style={placeStyle}>
        {/* The anchor, and nothing else, as on the block handle: it answers
            no pointer events, so Radix's trigger handlers never run on the
            button beside it. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden className='pointer-events-none absolute inset-0' />
        </DropdownMenuTrigger>
        <Button
          variant='chrome-ghost'
          size={null}
          aria-label={t(row ? 'spaces.document.table.rowHandle' : 'spaces.document.table.columnHandle')}
          data-testid={row ? 'doc-table-row-handle' : 'doc-table-col-handle'}
          className={
            row
              ? 'flex h-6 w-3 items-center justify-center rounded-chrome-sm border border-border bg-popover [&_svg]:size-3'
              : 'flex h-3 w-6 items-center justify-center rounded-chrome-sm border border-border bg-popover [&_svg]:size-3'
          }
          draggable
          onDragStart={(event) => {
            const view = editor.prosemirrorView;
            const pos =
              view === undefined || state.rowIndex === undefined || state.colIndex === undefined
                ? null
                : cellPosOf(view.state.doc, state.block.id, state.rowIndex, state.colIndex);
            if (view === undefined || pos === null || !startTableDrag(view, orientation, pos)) {
              event.preventDefault();
              return;
            }
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(TABLE_LINE_TYPE, '');
          }}
          onDragEnd={() => {
            const view = editor.prosemirrorView;
            if (view !== undefined) endTableDrag(view);
          }}
          onClick={() => {
            onOpenChange(!open);
          }}
        >
          {row ? <GripVertical /> : <GripHorizontal />}
        </Button>
      </div>
      <DropdownMenuContent
        side={row ? 'left' : 'top'}
        align='start'
        rowsClassName='flex flex-col gap-1'
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.focus();
        }}
      >
        {open ? <HandleMenuRows editor={editor} row={row} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
