// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Places a table's row and column handles (inner#1126 A6) on the cell the
 * pointer is over, for the table whose cells hold blocks (inner#1619).
 *
 * The placement is BlockNote's own `TableHandlesController`, its row and
 * column handles alone (the cell button is drawn on its own, rows and columns
 * are added from the handles' menus): the row handle at the table's left line
 * level with the cell, the column handle at its top line over the cell, both
 * hidden on a scroll unless a menu or a drag holds them.
 */

import { GenericPopover, type FloatingUIOptions, type GenericPopoverReference } from '@blocknote/react';
import { useExtension, useExtensionState } from '@blocknote/react';
import { autoUpdate, offset, type ReferenceElement } from '@floating-ui/react';
import * as React from 'react';

import type { HandleEditor } from '@web/spaces/document/document-handle-commands';
import {
  documentTableHandlesExtension,
  type TableHandlesState,
} from '@web/spaces/document/document-table-handles';
import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';
import { DocumentTableHandle } from '@web/spaces/document/DocumentTableHandle';

/** The row and column references the handles are placed by. */
interface References {
  readonly row?: GenericPopoverReference;
  readonly column?: GenericPopoverReference;
}

/**
 * The boxes the row and column handles are placed by: a row's box spans the
 * table across, a column's spans it down.
 * @param editor - The editor.
 * @param state - Which cell the pointer is over.
 * @returns The references, none while there is no cell to place by.
 */
function referencesOf(editor: HandleEditor, state: TableHandlesState | undefined): References {
  if (state === undefined || state.rowIndex === undefined || state.colIndex === undefined) return {};
  const frame = editor.domElement?.querySelector(`[data-node-type="${DOC_TABLE}"][data-id="${state.block.id}"]`);
  const table = frame?.querySelector('table');
  const cell = table?.querySelector('tbody')?.children[state.rowIndex]?.children[state.colIndex];
  if (table === null || table === undefined || cell === undefined) return {};
  return {
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
  const state = useExtensionState(documentTableHandlesExtension) as TableHandlesState | undefined;
  // While one handle's menu is open the other one is put away.
  const [only, setOnly] = React.useState<'row' | 'column' | undefined>();
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
        middleware: [offset(which === 'row' ? -10 : -12)],
        whileElementsMounted,
      },
      focusManagerProps: { disabled: true },
      elementProps: { style: { zIndex: 10 } },
    });
    return { row: of('row', open.row), column: of('column', open.column) };
  }, [open.row, open.column, whileElementsMounted]);

  const hideRowOthers = React.useCallback((hide: boolean) => setOnly(hide ? 'row' : undefined), []);
  const hideColumnOthers = React.useCallback((hide: boolean) => setOnly(hide ? 'column' : undefined), []);

  if (state === undefined) return null;
  return (
    <>
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
