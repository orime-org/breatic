import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { isInTable, selectedRect, selectionCell, TableMap } from '@tiptap/pm/tables';
import { MdDragIndicator } from 'react-icons/md';
import { RiAddFill } from 'react-icons/ri';
import { cn } from '@/utils/classnames';

function addTableRowAtEnd(editor: Editor): boolean {
  try {
    const { state, view } = editor;
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const cellOffset = map.positionAt(map.height - 1, 0, table);
    const abs = tableStart + cellOffset;
    const inner = Math.min(abs + 1, state.doc.content.size - 1);
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(inner)));
    view.dispatch(tr);
    return editor.chain().focus().addRowAfter().run();
  } catch {
    return false;
  }
}

function addTableColumnAtEnd(editor: Editor): boolean {
  try {
    const { state, view } = editor;
    const $cell = selectionCell(state);
    const table = $cell.node(-1);
    const tableStart = $cell.start(-1);
    const map = TableMap.get(table);
    const cellOffset = map.positionAt(0, map.width - 1, table);
    const abs = tableStart + cellOffset;
    const inner = Math.min(abs + 1, state.doc.content.size - 1);
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(inner)));
    view.dispatch(tr);
    return editor.chain().focus().addColumnAfter().run();
  } catch {
    return false;
  }
}

const menuItemsPanel = 'bn-table-handle-menu z-[10021] min-w-[220px] overflow-visible rounded-lg border border-border-default-base bg-background-default-base py-1 shadow-lg outline-none';

const menuItemClass = 'block w-full border-0 bg-transparent px-3 py-2 text-left text-[13px] text-text-default-base hover:bg-background-default-base-hover';

/** Row + column menus: open to the right of the grip, vertically centered on the handle */
const tableHandleMenuAnchorClass = 'absolute left-full top-1/2 ml-1.5 -translate-y-1/2';

/** Match `.bn-table-handle-row` / `.bn-table-handle-col` in editor.css */
const handleRowWidth = 18;
const handleRowHeight = 26;
const handleColWidth = 26;
const handleColHeight = 18;
const extendColMargin = 4;

/** Row/column grip chips (closed); menus use a higher layer when open so dropdown sits above the other grip */
const handleGripZ = 'calc(var(--bn-ui-base-z-index, 0) + 10)' as const;
const handleMenuLayerZ = 'calc(var(--bn-ui-base-z-index, 9990) + 50)' as const;
/** Below `.bubble-menu` in editor.css (z-index: 9998) */
const extendButtonZ = 'calc(var(--bn-ui-base-z-index, 9990) + 6)' as const;

type Layout = {
  row: { left: number; top: number };
  col: { left: number; top: number };
  extRow: { left: number; top: number; width: number };
  extCol: { left: number; top: number; height: number };
};

const layoutNearEqual = (a: Layout | null, b: Layout | null, eps = 0.5): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const n = (x: number, y: number) => Math.abs(x - y) < eps;
  return (
    n(a.row.left, b.row.left) &&
    n(a.row.top, b.row.top) &&
    n(a.col.left, b.col.left) &&
    n(a.col.top, b.col.top) &&
    n(a.extRow.left, b.extRow.left) &&
    n(a.extRow.top, b.extRow.top) &&
    n(a.extRow.width, b.extRow.width) &&
    n(a.extCol.left, b.extCol.left) &&
    n(a.extCol.top, b.extCol.top) &&
    n(a.extCol.height, b.extCol.height)
  );
};

const layoutHandles = (table: HTMLElement, cell: HTMLElement): Layout => {
  const t = table.getBoundingClientRect();
  const c = cell.getBoundingClientRect();
  return {
    row: {
      left: t.left - handleRowWidth / 2,
      top: c.top + (c.height - handleRowHeight) / 2,
    },
    col: {
      left: c.left + (c.width - handleColWidth) / 2,
      top: t.top - handleColHeight / 2,
    },
    extRow: {
      left: t.left,
      top: t.bottom,
      width: t.width,
    },
    extCol: {
      left: t.right + extendColMargin,
      top: t.top,
      height: t.height,
    },
  };
};

/**
 * TipTap's `editor.view.dom` throws until {@link EditorContent} has mounted the ProseMirror view.
 * The real view lives on the private `editorView` field — read it directly to avoid the proxy.
 */
const getPmView = (editor: Editor): EditorView | null => (editor as unknown as { editorView: EditorView | null }).editorView;

const getEditorRootDom = (editor: Editor): HTMLElement | null => getPmView(editor)?.dom ?? null;

const cellDom = (editor: Editor): { cell: HTMLElement; table: HTMLElement; row: HTMLTableRowElement } | null => {
  try {
    const view = getPmView(editor);
    if (!view) return null;
    const { selection } = editor.state;
    const { $head } = selection;
    const { node } = view.domAtPos($head.pos);
    let n: Node | null = node;
    if (n.nodeType === Node.TEXT_NODE) n = n.parentNode;
    let el = n as HTMLElement | null;
    while (el && el !== view.dom && !/^TD|TH$/i.test(el.tagName || '')) {
      el = el.parentElement;
    }
    if (!el || el === view.dom) return null;
    const row = el.parentElement as HTMLTableRowElement;
    const table = row.closest('table') as HTMLElement | null;
    if (!table) return null;
    return { cell: el, table, row };
  } catch {
    return null;
  }
};

const readGrid = (editor: Editor) => {
  try {
    const r = selectedRect(editor.state);
    return { row: r.top, col: r.left, map: r.map };
  } catch {
    return null;
  }
};

/** DOM row index among all `<tr>` in document order (thead + tbody + tfoot). */
const domCellRowCol = (cell: HTMLTableCellElement): { row: number; col: number } | null => {
  const tr = cell.parentElement as HTMLTableRowElement | null;
  if (!tr) return null;
  const table = cell.closest('table');
  if (!table) return null;
  const allRows = table.querySelectorAll('tr');
  let row = -1;
  for (let i = 0; i < allRows.length; i++) {
    if (allRows[i] === tr) {
      row = i;
      break;
    }
  }
  if (row < 0) return null;
  const col = Array.prototype.indexOf.call(tr.children, cell);
  if (col < 0) return null;
  return { row, col };
};

const BlockNoteTableHandles = ({ editor }: { editor: Editor }) => {
  const tick = useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const show = useMemo(() => {
    void tick;
    try {
      return editor.isEditable && isInTable(editor.state);
    } catch {
      return false;
    }
  }, [editor, tick]);

  const dom = useMemo(() => {
    void tick;
    return show ? cellDom(editor) : null;
  }, [editor, show, tick]);

  const domRef = useRef(dom);
  domRef.current = dom;

  const grid = useMemo(() => {
    void tick;
    return show ? readGrid(editor) : null;
  }, [editor, show, tick]);

  const gridRef = useRef(grid);
  gridRef.current = grid;

  const [hoverLastRow, setHoverLastRow] = useState(false);
  const [hoverLastCol, setHoverLastCol] = useState(false);
  const [columnResizeActive, setColumnResizeActive] = useState(false);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [openRowMenu, setOpenRowMenu] = useState(false);
  const [openColMenu, setOpenColMenu] = useState(false);

  const rowWrapRef = useRef<HTMLDivElement>(null);
  const colWrapRef = useRef<HTMLDivElement>(null);
  const layoutSnapshotRef = useRef<Layout | null>(null);

  const closeMenus = useCallback(() => {
    setOpenRowMenu(false);
    setOpenColMenu(false);
  }, []);

  const syncLayout = useCallback(() => {
    const d = domRef.current;
    if (!d) {
      if (layoutSnapshotRef.current !== null) {
        layoutSnapshotRef.current = null;
        setLayout(null);
      }
      return;
    }
    const next = layoutHandles(d.table, d.cell);
    if (layoutNearEqual(layoutSnapshotRef.current, next)) {
      return;
    }
    layoutSnapshotRef.current = next;
    setLayout(next);
  }, []);

  useLayoutEffect(() => {
    if (!dom) {
      if (layoutSnapshotRef.current !== null) {
        layoutSnapshotRef.current = null;
        setLayout(null);
      }
      return;
    }
    syncLayout();
  }, [dom, tick, syncLayout]);

  useEffect(() => {
    if (!dom) return;
    const onScrollOrResize = () => syncLayout();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    const ro = new ResizeObserver(onScrollOrResize);
    ro.observe(dom.table);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      ro.disconnect();
    };
  }, [dom, syncLayout]);

  const columnResizeRef = useRef(false);

  useEffect(() => {
    const pm = getPmView(editor)?.dom;
    if (!pm) return;

    const sync = () => {
      const next = pm.classList.contains('resize-cursor');
      if (columnResizeRef.current === next) return;
      columnResizeRef.current = next;
      setColumnResizeActive(next);
    };
    sync();

    const obs = new MutationObserver(sync);
    obs.observe(pm, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [editor]);

  const editorRootDom = getEditorRootDom(editor);
  const portalEl = editorRootDom?.closest('.breatic-editor-wrapper');
  const portalRoot =
    portalEl instanceof HTMLElement
      ? portalEl
      : typeof document !== 'undefined'
        ? document.body
        : null;

  useEffect(() => {
    if (!openRowMenu && !openColMenu) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (rowWrapRef.current?.contains(t)) return;
      if (colWrapRef.current?.contains(t)) return;
      closeMenus();
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [openRowMenu, openColMenu, closeMenus]);

  useEffect(() => {
    if (!openRowMenu && !openColMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRowMenu, openColMenu, closeMenus]);

  useEffect(() => {
    const pm = getEditorRootDom(editor);
    const root =
      (pm?.closest('.breatic-editor-wrapper') as HTMLElement | null) ??
      pm ??
      (typeof document !== 'undefined' ? document.body : null);
    if (!root) return;

    let lastHoverRow = false;
    let lastHoverCol = false;

    const onMove = (e: PointerEvent) => {
      const t = domRef.current?.table;
      const g = gridRef.current;

      if (!t || !g) {
        if (lastHoverRow || lastHoverCol) {
          lastHoverRow = false;
          lastHoverCol = false;
          setHoverLastRow(false);
          setHoverLastCol(false);
        }
        return;
      }

      const tableRect = t.getBoundingClientRect();
      const under = document.elementFromPoint(e.clientX, e.clientY);

      let lastRow = false;
      let lastCol = false;

      if (under instanceof Element) {
        lastRow = Boolean(under.closest('.bn-extend-button-add-remove-rows'));
        lastCol = Boolean(under.closest('.bn-extend-button-add-remove-columns'));
        const cell = under.closest('td, th');
        if (cell && t.contains(cell)) {
          const idx = domCellRowCol(cell as HTMLTableCellElement);
          if (idx) {
            if (!lastRow) lastRow = idx.row === g.map.height - 1;
            if (!lastCol) lastCol = idx.col === g.map.width - 1;
          }
        }
      }

      if (!lastRow) {
        const rows = t.querySelectorAll('tr');
        const lastTr = rows[rows.length - 1];
        if (lastTr instanceof HTMLElement) {
          const r = lastTr.getBoundingClientRect();
          const xPad = 6;
          const yBelow = 40;
          if (
            e.clientX >= tableRect.left - xPad &&
            e.clientX <= tableRect.right + xPad &&
            e.clientY >= r.bottom - 6 &&
            e.clientY <= r.bottom + yBelow
          ) {
            lastRow = true;
          }
        }
      }

      if (!lastCol) {
        const xPad = 6;
        const xRight = 40;
        if (
          e.clientX >= tableRect.right - xPad &&
          e.clientX <= tableRect.right + xRight &&
          e.clientY >= tableRect.top - 4 &&
          e.clientY <= tableRect.bottom + 4
        ) {
          lastCol = true;
        }
      }

      if (lastRow !== lastHoverRow || lastCol !== lastHoverCol) {
        lastHoverRow = lastRow;
        lastHoverCol = lastCol;
        setHoverLastRow(lastRow);
        setHoverLastCol(lastCol);
      }
    };

    root.addEventListener('pointermove', onMove, { passive: true });
    return () => root.removeEventListener('pointermove', onMove);
  }, [editor]);

  if (!show || !dom || !grid || !layout) return null;

  if (columnResizeActive) return null;

  const fixedLayer: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
  };

  const portal = (
    <>
      <div
        style={{
          ...fixedLayer,
          zIndex: openRowMenu ? handleMenuLayerZ : handleGripZ,
          left: layout.row.left,
          top: layout.row.top,
        }}
      >
        <div ref={rowWrapRef} className='pointer-events-auto relative'>
          <button
            type='button'
            className={cn('bn-table-handle bn-table-handle-row bn-table-handle-not-draggable')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpenColMenu(false);
              setOpenRowMenu((v) => !v);
            }}
            aria-label='Row'
            aria-expanded={openRowMenu}
            aria-haspopup='menu'
          >
            <MdDragIndicator size={16} />
          </button>
          {openRowMenu && (
            <div className={cn(menuItemsPanel, tableHandleMenuAnchorClass)} role='menu'>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().deleteRow().run();
                  closeMenus();
                }}
              >
                Delete row
              </button>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().addRowBefore().run();
                  closeMenus();
                }}
              >
                Add row above
              </button>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().addRowAfter().run();
                  closeMenus();
                }}
              >
                Add row below
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          ...fixedLayer,
          zIndex: openColMenu ? handleMenuLayerZ : handleGripZ,
          left: layout.col.left,
          top: layout.col.top,
        }}
      >
        <div ref={colWrapRef} className='pointer-events-auto relative'>
          <button
            type='button'
            className={cn('bn-table-handle bn-table-handle-col bn-table-handle-not-draggable')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpenRowMenu(false);
              setOpenColMenu((v) => !v);
            }}
            aria-label='Column'
            aria-expanded={openColMenu}
            aria-haspopup='menu'
          >
            <MdDragIndicator size={16} />
          </button>
          {openColMenu && (
            <div className={cn(menuItemsPanel, tableHandleMenuAnchorClass)} role='menu'>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().deleteColumn().run();
                  closeMenus();
                }}
              >
                Delete column
              </button>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().addColumnBefore().run();
                  closeMenus();
                }}
              >
                Add column left
              </button>
              <button
                type='button'
                role='menuitem'
                className={menuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().addColumnAfter().run();
                  closeMenus();
                }}
              >
                Add column right
              </button>
            </div>
          )}
        </div>
      </div>

      {hoverLastRow && (
        <div
          style={{
            ...fixedLayer,
            zIndex: extendButtonZ,
            left: layout.extRow.left,
            top: layout.extRow.top,
            width: layout.extRow.width,
          }}
          className='[&_*]:pointer-events-auto'
        >
          <button
            type='button'
            className='bn-extend-button bn-extend-button-add-remove-rows'
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addTableRowAtEnd(editor)}
            title='Add row'
          >
            <RiAddFill size={18} />
          </button>
        </div>
      )}

      {hoverLastCol && (
        <div
          style={{
            ...fixedLayer,
            zIndex: extendButtonZ,
            left: layout.extCol.left,
            top: layout.extCol.top,
            height: layout.extCol.height,
          }}
          className='[&_*]:pointer-events-auto'
        >
          <button
            type='button'
            className='bn-extend-button bn-extend-button-add-remove-columns'
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addTableColumnAtEnd(editor)}
            title='Add column'
          >
            <RiAddFill size={18} />
          </button>
        </div>
      )}
    </>
  );

  if (!portalRoot) return null;
  return createPortal(portal, portalRoot);
};

export default BlockNoteTableHandles;
