// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Places a table's row and column handles (inner#1126 A6) on the cell the
 * pointer is over, for the table whose cells hold blocks (inner#1619), and the
 * table's own strip beside it whenever the table is hovered, together with
 * them and with the strip of a block in a cell (inner#1619 T13, user
 * 2026-10-21). The table's strip is the body's strip (`BlockStrip`), placed
 * as the side menu places it; the side menu itself leaves tables to it.
 *
 * The placement is BlockNote's own `TableHandlesController`, its row and
 * column handles alone (the cell button is drawn on its own, rows and columns
 * are added from the handles' menus): the row handle at the table's left line
 * level with the cell, the column handle at its top line over the cell, both
 * hidden on a scroll unless a menu or a drag holds them.
 */

import { SideMenuExtension } from '@blocknote/core/extensions';
import { GenericPopover, type FloatingUIOptions, type GenericPopoverReference } from '@blocknote/react';
import { useExtension, useExtensionState } from '@blocknote/react';
import { autoUpdate, offset, type ReferenceElement } from '@floating-ui/react';
import * as React from 'react';

import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import { stripPlacement } from '@web/spaces/document/document-strip-alignment';
import {
  documentTableHandlesExtension,
  TABLE_CONTROL,
  type TableHandlesState,
} from '@web/spaces/document/document-table-handles';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';
import { HANDLE_THICKNESS } from '@web/spaces/document/document-table-control-place';
import { DocumentTableHandle } from '@web/spaces/document/DocumentTableHandle';
import { BlockStrip, type StripHold } from '@web/spaces/document/DocumentBlockHandle';

/** The references the table's strip and its row and column handles are placed by. */
interface References {
  readonly table?: GenericPopoverReference;
  readonly row?: GenericPopoverReference;
  readonly column?: GenericPopoverReference;
}

/**
 * The boxes the handles are placed by, read off the table as it is drawn now:
 * a move redraws the table, and the strip follows it there. A row's box spans
 * the table across, a column's spans it down.
 * @param editor - The editor.
 * @param state - Which table, and which cell, the pointer is over.
 * @returns The references; no row or column one while there is no cell to place by.
 */
function referencesOf(editor: HandleEditor, state: TableHandlesState | undefined): References {
  if (state === undefined) return {};
  const frame = editor.domElement?.querySelector(`[data-node-type="${DOC_TABLE}"][data-id="${state.block.id}"]`);
  if (frame === null || frame === undefined) return {};
  const own = { table: { element: frame } };
  if (state.rowIndex === undefined || state.colIndex === undefined) return own;
  const table = frame.querySelector('table');
  const cell = table?.querySelector('tbody')?.children[state.rowIndex]?.children[state.colIndex];
  if (table === null || table === undefined || cell === undefined) return own;
  return {
    ...own,
    row: {
      element: table,
      getBoundingClientRect: () => {
        const box = table.getBoundingClientRect();
        const line = cell.getBoundingClientRect();
        return new DOMRect(box.x, line.y, box.width, line.height);
      },
    },
    column: {
      element: table,
      getBoundingClientRect: () => {
        const box = table.getBoundingClientRect();
        const line = cell.getBoundingClientRect();
        return new DOMRect(line.x, box.y, line.width, box.height);
      },
    },
  };
}

/**
 * The controller.
 * @param props - The editor.
 * @param props.editor - The editor the handles act on.
 * @returns The two handles, placed.
 */
export function DocumentTableHandlesController({ editor }: { editor: HandleEditor }): React.JSX.Element | null {
  const handles = useExtension(documentTableHandlesExtension);
  const sideMenu = useExtension(SideMenuExtension);
  const state = useExtensionState(documentTableHandlesExtension) as TableHandlesState | undefined;
  // While one handle's menu is open or its drag runs the others are put away.
  const [only, setOnly] = React.useState<'row' | 'column' | 'table' | undefined>();
  const references = React.useMemo(() => referencesOf(editor, state), [editor, state]);

  // Hides the handles on a scroll of anything around the table, so they never
  // stand outside the body's scroller.
  const whileElementsMounted = React.useCallback(
    (reference: ReferenceElement, floating: HTMLElement): (() => void) => {
      let placed = false;
      return autoUpdate(
        reference,
        floating,
        () => {
          if (!placed) {
            placed = true;
            return;
          }
          handles.hideHandlesIfNotFrozen();
        },
        { ancestorScroll: true, ancestorResize: false, elementResize: false, layoutShift: false },
      );
    },
    [handles],
  );

  const open = {
    row: state?.show === true && state.rowIndex !== undefined && (only === undefined || only === 'row'),
    column: state?.show === true && state.colIndex !== undefined && (only === undefined || only === 'column'),
    table: state?.show === true && (only === undefined || only === 'table'),
  };
  const options = React.useMemo<Record<'row' | 'column', FloatingUIOptions>>(() => {
    /**
     * One handle's floating options.
     * @param which - The row or the column.
     * @param shown - Whether it is shown.
     * @returns The options.
     */
    const of = (which: 'row' | 'column', shown: boolean): FloatingUIOptions => ({
      useFloatingOptions: {
        open: shown,
        placement: which === 'row' ? 'left' : 'top',
        // Half the handle's 12px thickness back over the line: centred on it.
        middleware: [offset(-HANDLE_THICKNESS / 2)],
        whileElementsMounted,
      },
      focusManagerProps: { disabled: true },
      elementProps: { style: { zIndex: 10 } },
    });
    return { row: of('row', open.row), column: of('column', open.column) };
  }, [open.row, open.column, whileElementsMounted]);

  const placement = React.useMemo(() => stripPlacement(() => editor.domElement ?? undefined), [editor]);
  const tableOptions = React.useMemo<FloatingUIOptions>(
    () => ({
      useFloatingOptions: {
        ...placement.useFloatingOptions,
        open: open.table,
        placement: 'left-start',
        whileElementsMounted,
      },
      focusManagerProps: { disabled: true },
      // The side menu's own layer.
      elementProps: { style: { zIndex: 20 } },
    }),
    [placement, open.table, whileElementsMounted],
  );
  // The side menu is held too, as it is for its own strip: a frozen side
  // menu is what keeps BlockNote's drop handling on the row in flight
  // (`SideMenu.ts` ends a drag on a move with no button held unless frozen).
  const tableHold = React.useMemo<StripHold>(
    () => ({
      freeze: () => {
        handles.freezeHandles();
        sideMenu.freezeMenu();
        setOnly('table');
      },
      unfreeze: () => {
        handles.unfreezeHandles();
        sideMenu.unfreezeMenu();
        setOnly(undefined);
      },
    }),
    [handles, sideMenu],
  );
  const tableId = state?.block.id;
  const table = React.useMemo(() => (tableId === undefined ? undefined : { id: tableId, type: DOC_TABLE }), [tableId]);

  const hideRowOthers = React.useCallback((hide: boolean) => setOnly(hide ? 'row' : undefined), []);
  const hideColumnOthers = React.useCallback((hide: boolean) => setOnly(hide ? 'column' : undefined), []);

  if (state === undefined) return null;
  return (
    <>
      <GenericPopover reference={open.table ? references.table : undefined} {...tableOptions}>
        {open.table ? (
          <div {...{ [TABLE_CONTROL]: '' }}>
            <BlockStrip block={table} hold={tableHold} />
          </div>
        ) : null}
      </GenericPopover>
      <GenericPopover reference={references.row} {...options.row}>
        {open.row ? (
          <DocumentTableHandle orientation='row' hideOtherElements={hideRowOthers} />
        ) : null}
      </GenericPopover>
      <GenericPopover reference={references.column} {...options.column}>
        {open.column ? (
          <DocumentTableHandle orientation='column' hideOtherElements={hideColumnOthers} />
        ) : null}
      </GenericPopover>
    </>
  );
}
