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
 * `<th>` and its row. At a table's height off its cells — the gutter out to
 * where the table's own strip stands, the room right of the table — the state
 * names the table and no cell: the table's strip shows whenever the table is
 * hovered, as a body block's does (inner#1619 T13, user 2026-10-21), and the
 * row and column handles only over a cell, its padding included. A press in a
 * cell that turns into a drag selection takes the handles away until the
 * button comes up, so they stay out of the reader's way.
 */

import { createExtension, createStore, type BlockNoteEditor } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { SCROLL_VIEWPORT } from '@web/spaces/document/document-body-autoscroll';
import { tableStripLeft } from '@web/spaces/document/document-strip-alignment';
import { cellDepthOf, DOC_TABLE } from '@web/spaces/document/document-table-nodes';

/** The cell the handles stand on, and the boxes they are placed by. */
export interface TableHandlesState {
  readonly show: boolean;
  readonly block: { readonly id: string };
  readonly rowIndex: number | undefined;
  readonly colIndex: number | undefined;
  /** The hovered cell's box, read when the handles were last placed. */
  readonly referencePosCell: DOMRect | undefined;
  /** The position before the hovered cell. */
  readonly cellPos: number | undefined;
}

/**
 * The attribute on the table's controls drawn outside the body — the row and
 * column handles, the cell button: the pointer on one keeps the handles up.
 */
export const TABLE_CONTROL = 'data-doc-table-control';

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

/**
 * The position before a cell drawn in the body.
 * @param view - The editor view.
 * @param cell - The cell's element.
 * @returns The position, or undefined when it is not in the document.
 */
function posBefore(view: EditorView, cell: Element): number | undefined {
  const $inside = view.state.doc.resolve(view.posAtDOM(cell, 0));
  const depth = cellDepthOf($inside);
  return depth < 0 ? undefined : $inside.before(depth);
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
    // On the window: a pointer leaving the body has to take the handles away.
    window.addEventListener('mousemove', this.onMove);
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
    // A press the browser ended without a release, a native drag and drop,
    // is over once no button is held.
    if (event.buttons === 0) this.press = 'up';
    if (this.frozen || this.press === 'selecting') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A control keeps the handles it belongs to. A control while none are up
    // is the still copy a closing popover fades out with, standing where the
    // table's strip stood: the table is read off the pointer's place there.
    const onControl = target.closest(`[${TABLE_CONTROL}]`) !== null;
    if (onControl && this.state?.show === true) return;
    // The gutter is the scroller's padding, outside the editable element, and
    // a block's strip stands in it on the way to the table's.
    const inBody =
      onControl ||
      this.view.dom.contains(target) ||
      target.closest('[data-row-id]') !== null ||
      target.closest(SCROLL_VIEWPORT)?.contains(this.view.dom) === true;
    // A missing cell drawn at the end of a short row is no cell: the pointer
    // there is on the table, as in its gutter.
    const cell = inBody && !onControl ? target.closest('td:not([data-doc-table-missing]), th:not([data-doc-table-missing])') : null;
    const frame = cell === null ? (inBody ? this.tableAt(event) : null) : cell.closest(FRAME);
    const id = frame?.getAttribute('data-id');
    if (frame === null || frame === undefined || id === null || id === undefined || !this.editor.isEditable) {
      this.hide();
      return;
    }
    if (this.press === 'down') {
      this.press = 'selecting';
      this.hide();
      return;
    }
    const rowIndex = cell === null ? undefined : indexOf(cell.parentElement!);
    const colIndex = cell === null ? undefined : indexOf(cell);
    if (this.state?.show === true && this.state.block.id === id && this.state.rowIndex === rowIndex && this.state.colIndex === colIndex) {
      return;
    }
    this.state = {
      show: true,
      block: { id },
      rowIndex,
      colIndex,
      referencePosCell: cell?.getBoundingClientRect(),
      cellPos: cell === null ? undefined : posBefore(this.view, cell),
    };
    this.emit(this.state);
  };

  /**
   * The table at the pointer's height, off its cells: from where the table's
   * own strip stands out to the frame's right edge, the body's.
   * @param event - The move.
   * @returns The table's frame, or null when no table is there.
   */
  private tableAt(event: MouseEvent): Element | null {
    const left = tableStripLeft(this.view.dom);
    if (left === undefined || event.clientX < left) return null;
    for (const frame of this.view.dom.querySelectorAll(FRAME)) {
      const body = frame.querySelector('tbody');
      if (body === null) continue;
      const box = body.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom) continue;
      if (event.clientX <= frame.getBoundingClientRect().right) return frame;
    }
    return null;
  }

  /** Follows the table through a change: gone, shrunk, or moved. */
  update(): void {
    // Hidden handles are placed again from the DOM on the next move over a
    // cell (BlockNote's own view keeps the same guard, `TableHandles.ts`).
    if (this.state?.show !== true) return;
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
      cellPos: cell === undefined ? undefined : posBefore(this.view, cell),
    };
    this.emit(this.state);
  }

  /** Stops following the pointer. */
  destroy(): void {
    window.removeEventListener('mousemove', this.onMove);
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
