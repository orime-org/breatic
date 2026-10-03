// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A table's row and column handles and the plus on its edge (inner#1126 A6,
 * A8), handed to the library's `TableHandlesController` in place of its own,
 * which read a `ComponentsContext` this build does not provide.
 *
 * The controller places them and reports which row and column the pointer is
 * over; everything else is ours. A handle's menu acts on the cell the menu
 * was opened on, held in `document-table-target.ts` and mapped through every
 * change while the menu is open, so an edit someone else makes above the
 * table cannot point a command at another row. The library's own table
 * position is written on pointer moves only and goes stale under such an edit,
 * so no command reads it.
 *
 * None of the three is on screen while the reader holds a selection: the
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
  Plus,
} from 'lucide-react';
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
  appendColumn,
  appendRow,
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
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';
import { useEditorSnapshot } from '@web/spaces/document/use-editor-snapshot';

/** What the library's handle state carries, as far as these read it. */
interface HandlesState {
  readonly show: boolean;
  readonly block: { readonly id: string };
  readonly rowIndex: number | undefined;
  readonly colIndex: number | undefined;
}

/** What the controller hands a handle. */
interface TableHandleProps {
  readonly orientation: 'row' | 'column';
  readonly hideOtherElements: (hide: boolean) => void;
}

/** What the controller hands the edge plus. */
interface TableExtendProps {
  readonly orientation: 'addOrRemoveRows' | 'addOrRemoveColumns';
  readonly hideOtherElements: (hide: boolean) => void;
}

/** The delete row's icon, shared with the block handle's menu. */
const DeleteIcon = BLOCK_MENU_ROWS.find((row) => row.id === 'delete')!.Icon;

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
        setTableTarget(view, pos);
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
    [editor, handles, hideOtherElements, state],
  );
  const close = React.useCallback((): void => {
    onOpenChange(false);
  }, [onOpenChange]);
  useCloseWhenTargetGone(editor, open, close);

  if (state === undefined || (holdsSelection && !open)) return null;
  const index = row ? state.rowIndex : state.colIndex;
  if (index === undefined) return null;

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <div className='relative flex'>
        {/* The anchor, and nothing else, as on the block handle: it answers
            no pointer events, so Radix's trigger handlers never run on the
            button beside it. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden className='pointer-events-none absolute inset-0' />
        </DropdownMenuTrigger>
        <Button
          variant={null}
          size={null}
          aria-label={t(row ? 'spaces.document.table.rowHandle' : 'spaces.document.table.columnHandle')}
          data-testid={row ? 'doc-table-row-handle' : 'doc-table-col-handle'}
          className={
            row
              ? 'flex h-6 w-3 items-center justify-center rounded-chrome-sm border border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3'
              : 'flex h-3 w-6 items-center justify-center rounded-chrome-sm border border-border bg-popover text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3'
          }
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

/**
 * The plus below the table or to its right: one press adds a row or a column.
 * @param props - What the controller hands it.
 * @param props.orientation - Rows or columns.
 * @returns The plus, or null while there is nothing to point at.
 */
export function DocumentTableExtend({ orientation }: TableExtendProps): React.JSX.Element | null {
  const t = useTranslation();
  const editor = useBlockNoteEditor() as unknown as HandleEditor;
  const state = useExtensionState(TableHandlesExtension) as HandlesState | undefined;
  const holdsSelection = useHoldsSelection(editor);
  const rows = orientation === 'addOrRemoveRows';

  if (state === undefined || holdsSelection) return null;

  return (
    <Button
      variant={null}
      size={null}
      aria-label={t(rows ? 'spaces.document.table.addRow' : 'spaces.document.table.addColumn')}
      data-testid={rows ? 'doc-table-extend-rows' : 'doc-table-extend-cols'}
      className={
        rows
          ? 'flex h-4 w-full items-center justify-center rounded-chrome-sm bg-accent text-muted-foreground hover:text-foreground [&_svg]:size-3'
          : 'flex h-full w-4 items-center justify-center rounded-chrome-sm bg-accent text-muted-foreground hover:text-foreground [&_svg]:size-3'
      }
      onClick={() => {
        // Found by the block's id at the press, which no edit elsewhere moves.
        const pos = cellPosOf(editor.prosemirrorState.doc, state.block.id, 0, 0);
        if (pos === null) return;
        if (rows) appendRow(editor, pos);
        else appendColumn(editor, pos);
      }}
    >
      <Plus />
    </Button>
  );
}
