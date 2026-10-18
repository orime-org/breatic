// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which cell of which table the pointer is over: the state the row and
 * column handles stand on (inner#1126 A6), for the table whose cells hold
 * blocks (inner#1619).
 *
 * BlockNote's own `TableHandlesExtension` reads only its built-in table. This
 * is the same contract — the state its handles read, `freezeHandles` while a
 * handle's menu is open or its drag runs — read off the layout table's DOM:
 * the frame (`[data-node-type="docTable"]`), its `<tbody>`, a `<td>` or
 * `<th>` and its row. A press in a cell that turns into a drag selection
 * takes the handles away until the button comes up, so they stay out of the
 * reader's way.
 */

import { createExtension, createStore, type BlockNoteEditor } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The cell the handles stand on, and the boxes they are placed by. */
export interface TableHandlesState {
  readonly show: boolean;
  readonly block: { readonly id: string };
  readonly rowIndex: number | undefined;
  readonly colIndex: number | undefined;
  /** The hovered cell's box, read when the handles were last placed. */
  readonly referencePosCell: DOMRect | undefined;
  /** The table body's box. */
  readonly referencePosTable: DOMRect;
}

/** The selector of a table's frame. */
const FRAME = `[data-node-type="${DOC_TABLE}"]`;

/**
 * An element's place among its parent's element children.
 * @param element - The element.
 * @returns Its index.
 */
function indexOf(element: Element): number {
  return element.parentElement === null ? -1 : [...element.parentElement.children].indexOf(element);
}

/** The plugin view that follows the pointer over tables. */
class TableHoverView {
  /** True while a handle's menu is open or its drag runs. */
  frozen = false;

  private state: TableHandlesState | undefined;

  private press: 'up' | 'down' | 'selecting' = 'up';

  /**
   * Starts following the pointer.
   * @param editor - The editor, for whether it can be edited.
   * @param view - The editor view.
   * @param emit - Hands the state on.
   */
  constructor(
    private readonly editor: Pick<BlockNoteEditor<never, never, never>, 'isEditable'>,
    private readonly view: EditorView,
    private readonly emit: (state: TableHandlesState | undefined) => void,
  ) {
    view.dom.addEventListener('mousemove', this.onMove);
    view.dom.addEventListener('mousedown', this.onDown);
    window.addEventListener('mouseup', this.onUp);
  }

  /** Notes a press in the body. */
  private readonly onDown = (): void => {
    this.press = 'down';
  };

  /**
   * Ends a press, and reads where the pointer is now.
   * @param event - The release.
   */
  private readonly onUp = (event: MouseEvent): void => {
    this.press = 'up';
    this.onMove(event);
  };

  /** Takes the handles away, keeping the table and cell they were on. */
  hide(): void {
    if (this.state?.show !== true) return;
    this.state = { ...this.state, show: false };
    this.emit(this.state);
  }

  /**
   * Reads which cell the pointer is over.
   * @param event - The move.
   */
  private readonly onMove = (event: MouseEvent): void => {
    if (this.frozen || this.press === 'selecting') return;
    const target = event.target;
    if (!(target instanceof Element) || !this.view.dom.contains(target)) return;
    const cell = target.closest('td, th');
    const frame = cell?.closest(FRAME);
    const body = frame?.querySelector('tbody');
    const id = frame?.getAttribute('data-id');
    if (cell === null || cell === undefined || body === null || body === undefined || id === null || id === undefined) {
      this.hide();
      return;
    }
    if (!this.editor.isEditable) {
      this.hide();
      return;
    }
    if (this.press === 'down') {
      this.press = 'selecting';
      this.hide();
      return;
    }
    const rowIndex = indexOf(cell.parentElement!);
    const colIndex = indexOf(cell);
    if (this.state?.show === true && this.state.block.id === id && this.state.rowIndex === rowIndex && this.state.colIndex === colIndex) {
      return;
    }
    this.state = {
      show: true,
      block: { id },
      rowIndex,
      colIndex,
      referencePosCell: cell.getBoundingClientRect(),
      referencePosTable: body.getBoundingClientRect(),
    };
    this.emit(this.state);
  };

  /** Follows the table through a change: gone, shrunk, or moved. */
  update(): void {
    if (this.state === undefined) return;
    const frame = this.view.dom.querySelector(`${FRAME}[data-id="${this.state.block.id}"]`);
    const body = frame?.querySelector('tbody');
    if (body === null || body === undefined) {
      this.state = undefined;
      this.emit(undefined);
      return;
    }
    const rows = body.children;
    let { rowIndex, colIndex } = this.state;
    if (rowIndex !== undefined && rowIndex >= rows.length) rowIndex = rows.length - 1;
    const row = rowIndex === undefined ? undefined : rows[rowIndex];
    if (row !== undefined && colIndex !== undefined && colIndex >= row.children.length) colIndex = row.children.length - 1;
    const cell = row === undefined || colIndex === undefined ? undefined : row.children[colIndex];
    this.state = {
      ...this.state,
      rowIndex: cell === undefined ? undefined : rowIndex,
      colIndex: cell === undefined ? undefined : colIndex,
      referencePosCell: cell?.getBoundingClientRect(),
      referencePosTable: body.getBoundingClientRect(),
    };
    this.emit(this.state);
  }

  /** Stops following the pointer. */
  destroy(): void {
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.view.dom.removeEventListener('mousedown', this.onDown);
    window.removeEventListener('mouseup', this.onUp);
  }
}

/**
 * The extension: the state, and freezing it.
 * @returns The extension, for the assembly to register.
 */
export const documentTableHandlesExtension = createExtension(({ editor }) => {
  const store = createStore<TableHandlesState | undefined>(undefined);
  let view: TableHoverView | undefined;
  return {
    key: 'documentTableHandles',
    store,
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentTableHandles'),
        view: (editorView) => {
          view = new TableHoverView(editor as never, editorView, (state) => {
            store.setState(state === undefined ? undefined : { ...state });
          });
          return view;
        },
      }),
    ],
    /** Keeps the handles on their cell, whatever the pointer does. */
    freezeHandles(): void {
      if (view !== undefined) view.frozen = true;
    },
    /** Lets the handles follow the pointer again. */
    unfreezeHandles(): void {
      if (view !== undefined) view.frozen = false;
    },
    /** Takes the handles away unless a menu or a drag holds them. */
    hideHandlesIfNotFrozen(): void {
      if (view !== undefined && !view.frozen) view.hide();
    },
  } as const;
});
