import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { isInTable, selectedRect, selectionCell, TableMap } from '@tiptap/pm/tables';
import { MdDragIndicator } from 'react-icons/md';
import {
  RiAddFill,
  RiAlignCenter,
  RiAlignLeft,
  RiAlignRight,
  RiArrowDownLine,
  RiArrowLeftLine,
  RiArrowRightLine,
  RiArrowRightSLine,
  RiArrowUpLine,
  RiDeleteBin6Line,
  RiFileCopy2Line,
  RiInsertColumnLeft,
  RiInsertColumnRight,
  RiInsertRowBottom,
  RiInsertRowTop,
  RiIndentDecrease,
  RiIndentIncrease,
  RiPaletteLine,
} from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import { TextColorPalettePanel } from '@/apps/project/components/textEditor/formatting/TextColorSelect';
import { BlockIndentAlignIcon } from '@/apps/project/components/textEditor/ui/TextEditorIcons';
import {
  decreaseBlockIndent,
  increaseBlockIndent,
} from '@/apps/project/components/textEditor/extensions/BlockIndentExtension';

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

/* ─── Table structure helpers (uniform grid; no colspan) ───────────────── */

function tableSelRect(editor: Editor) {
  try {
    return selectedRect(editor.state);
  } catch {
    return null;
  }
}

function isRectangularGrid(table: PMNode, mapWidth: number): boolean {
  let ok = true;
  table.forEach((row) => {
    if (row.childCount !== mapWidth) ok = false;
  });
  return ok;
}

function replaceTableNode(editor: Editor, newTable: PMNode): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  view.dispatch(state.tr.replaceWith(r.tableStart, r.tableStart + r.table.nodeSize, newTable));
  return true;
}

function moveTableColumn(editor: Editor, direction: 'left' | 'right'): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { map, table } = r;
  const col = r.left;
  const next = direction === 'left' ? col - 1 : col + 1;
  if (next < 0 || next >= map.width) return false;
  if (!isRectangularGrid(table, map.width)) return false;
  const newRows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((c) => cells.push(c));
    const copy = [...cells];
    [copy[col], copy[next]] = [copy[next], copy[col]];
    newRows.push(row.type.create(row.attrs, Fragment.fromArray(copy)));
  });
  return replaceTableNode(editor, table.type.create(table.attrs, Fragment.fromArray(newRows)));
}

function moveTableRow(editor: Editor, direction: 'up' | 'down'): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { map, table } = r;
  const row = r.top;
  const next = direction === 'up' ? row - 1 : row + 1;
  if (next < 0 || next >= map.height) return false;
  const rows: PMNode[] = [];
  table.forEach((rw) => rows.push(rw));
  const copy = [...rows];
  [copy[row], copy[next]] = [copy[next], copy[row]];
  return replaceTableNode(editor, table.type.create(table.attrs, Fragment.fromArray(copy)));
}

function duplicateTableColumn(editor: Editor, colIndex: number): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { map, table } = r;
  if (colIndex < 0 || colIndex >= map.width) return false;
  if (!isRectangularGrid(table, map.width)) return false;
  const newRows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((c) => cells.push(c));
    const cell = cells[colIndex];
    const dup = cell.type.create(cell.attrs, cell.content, cell.marks);
    newRows.push(
      row.type.create(
        row.attrs,
        Fragment.fromArray([...cells.slice(0, colIndex + 1), dup, ...cells.slice(colIndex + 1)]),
      ),
    );
  });
  return replaceTableNode(editor, table.type.create(table.attrs, Fragment.fromArray(newRows)));
}

function duplicateTableRow(editor: Editor, rowIndex: number): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { map, table } = r;
  if (rowIndex < 0 || rowIndex >= map.height) return false;
  const rows: PMNode[] = [];
  table.forEach((rw) => rows.push(rw));
  const row = rows[rowIndex];
  const dup = row.type.create(row.attrs, row.content, row.marks);
  return replaceTableNode(
    editor,
    table.type.create(
      table.attrs,
      Fragment.fromArray([...rows.slice(0, rowIndex + 1), dup, ...rows.slice(rowIndex + 1)]),
    ),
  );
}

function setTableColumnCellAlign(editor: Editor, colIndex: number, align: 'left' | 'center' | 'right' | null): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let row = 0; row < map.height; row++) {
    const abs = tableStart + map.map[row * map.width + colIndex];
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, align: align ?? null });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

function setTableRowCellAlign(editor: Editor, rowIndex: number, align: 'left' | 'center' | 'right' | null): boolean {
  const r = tableSelRect(editor);
  if (!r) return false;
  const { state, view } = editor;
  const { map, tableStart } = r;
  let tr = state.tr;
  for (let col = 0; col < map.width; col++) {
    const abs = tableStart + map.map[rowIndex * map.width + col];
    const cell = tr.doc.nodeAt(abs);
    if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
    tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, align: align ?? null });
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

const tableHandleMenuSurfaceClass =
  'bn-table-handle-menu min-w-[220px] overflow-visible rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)] outline-none';

const tableMenuDivider = 'my-1.5 border-t border-border-default-base';

const tableMenuItemClass =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary disabled:cursor-not-allowed disabled:opacity-40';

const tableMenuSubPanelSurfaceClass =
  'min-w-[192px] rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)]';

const TABLE_HANDLE_MENU_Z = 76;
const TABLE_HANDLE_SUBMENU_Z = 77;

type TableHandleFloatRef = RefObject<HTMLDivElement | null>;

function TableHandleFloatingMenu({
  open,
  anchorEl,
  children,
  className,
  zIndex,
  floatingRef,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  children: React.ReactNode;
  className: string;
  zIndex: number;
  floatingRef: TableHandleFloatRef;
}) {
  const { refs, floatingStyles } = useFloating({
    open,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    if (open && anchorEl) refs.setReference(anchorEl);
  }, [open, anchorEl, refs]);

  useLayoutEffect(() => {
    if (!open) floatingRef.current = null;
  }, [open, floatingRef]);

  if (!open) return null;

  return (
    <FloatingPortal>
      <div
        ref={(node) => {
          refs.setFloating(node);
          floatingRef.current = node;
        }}
        style={{ ...floatingStyles, zIndex }}
        className={className}
        role='menu'
      >
        {children}
      </div>
    </FloatingPortal>
  );
}

function TableHandleFloatingSubmenu({
  open,
  anchorEl,
  children,
  className,
  zIndex,
  floatingRef,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  children: React.ReactNode;
  className: string;
  zIndex: number;
  floatingRef: TableHandleFloatRef;
}) {
  const { refs, floatingStyles } = useFloating({
    open,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  useLayoutEffect(() => {
    if (open && anchorEl) refs.setReference(anchorEl);
  }, [open, anchorEl, refs]);

  useLayoutEffect(() => {
    if (!open) floatingRef.current = null;
  }, [open, floatingRef]);

  if (!open) return null;

  return (
    <FloatingPortal>
      <div
        ref={(node) => {
          refs.setFloating(node);
          floatingRef.current = node;
        }}
        style={{ ...floatingStyles, zIndex }}
        className={className}
        role='menu'
      >
        {children}
      </div>
    </FloatingPortal>
  );
}

/** Match BlockTypeMenu “Indent & align” submenu labels. */
const blockMenuLabelClass =
  'px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-default-tertiary select-none';

function runTableSinkOrLift(editor: Editor, dir: 'sink' | 'lift', onDone: () => void): void {
  if (dir === 'sink') increaseBlockIndent(editor);
  else decreaseBlockIndent(editor);
  onDone();
}

/** Row and column table grip dimensions in pixels. */
const handleRowWidth = 18;
const handleRowHeight = 26;
const handleColWidth = 26;
const handleColHeight = 18;
const extendColMargin = 4;

/** Row/column grip chips (closed); menus use a higher layer when open. */
const handleGripZ = 62;
const handleMenuLayerZ = 75;
/** Keep extend buttons below menus and bubble toolbar. */
const extendButtonZ = 61;

type Layout = {
  row: { left: number; top: number };
  col: { left: number; top: number };
  extRow: { left: number; top: number; width: number };
  extCol: { left: number; top: number; height: number };
};

type TableHandleSubmenu = 'none' | 'color' | 'align';

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

/** Reads ProseMirror `EditorView` from the editor before `view.dom` is available on the public API. */
const getPmView = (editor: Editor): EditorView | null =>
  (editor as unknown as { editorView: EditorView | null }).editorView;

const getEditorRootDom = (editor: Editor): HTMLElement | null => getPmView(editor)?.dom ?? null;

type TableCellDom = { cell: HTMLElement; table: HTMLElement; row: HTMLTableRowElement };

const cellDom = (editor: Editor): TableCellDom | null => {
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

/** Cell under the pointer (no caret inside the table required). */
const cellDomAtPoint = (editor: Editor, clientX: number, clientY: number): TableCellDom | null => {
  const view = getPmView(editor);
  if (!view) return null;
  try {
    const hit = document.elementFromPoint(clientX, clientY);
    if (!(hit instanceof Element)) return null;
    const cell = hit.closest('td, th');
    if (!(cell instanceof HTMLElement) || !/^TD|TH$/i.test(cell.tagName)) return null;
    if (!view.dom.contains(cell)) return null;
    const table = cell.closest('table') as HTMLElement | null;
    if (!table || !view.dom.contains(table)) return null;
    const row = cell.parentElement as HTMLTableRowElement | null;
    if (!row) return null;
    return { cell, table, row };
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

/** Row/col for the hovered cell from the document model (works without a table selection). */
const readGridForDomCell = (editor: Editor, cellEl: HTMLTableCellElement): { row: number; col: number; map: TableMap } | null => {
  const view = getPmView(editor);
  if (!view) return null;
  const idx = domCellRowCol(cellEl);
  if (!idx) return null;
  try {
    const pos = view.posAtDOM(cellEl, 0);
    const $pos = view.state.doc.resolve(pos);
    let tableDepth = -1;
    for (let d = $pos.depth; d > 0; d -= 1) {
      if ($pos.node(d).type.name === 'table') {
        tableDepth = d;
        break;
      }
    }
    if (tableDepth < 0) return null;
    const table = $pos.node(tableDepth);
    const map = TableMap.get(table);
    if (idx.row < 0 || idx.row >= map.height || idx.col < 0 || idx.col >= map.width) return null;
    return { row: idx.row, col: idx.col, map };
  } catch {
    return null;
  }
};

const TableHandles = ({ editor }: { editor: Editor }) => {
  const tick = useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const [tableLayoutDom, setTableLayoutDom] = useState<TableCellDom | null>(null);
  const lastTableDomRef = useRef<TableCellDom | null>(null);
  const menusOpenRef = useRef(false);

  const dom = tableLayoutDom;

  const domRef = useRef(dom);
  domRef.current = dom;

  const grid = useMemo(() => {
    void tick;
    if (!dom) return null;
    if (dom.cell instanceof HTMLTableCellElement) {
      const g = readGridForDomCell(editor, dom.cell);
      if (g) return g;
    }
    try {
      if (!isInTable(editor.state)) return null;
      return readGrid(editor);
    } catch {
      return null;
    }
  }, [editor, dom, tick]);

  const gridRef = useRef(grid);
  gridRef.current = grid;

  const [hoverLastRow, setHoverLastRow] = useState(false);
  const [hoverLastCol, setHoverLastCol] = useState(false);
  const [columnResizeActive, setColumnResizeActive] = useState(false);

  const [layout, setLayout] = useState<Layout | null>(null);
  const [openRowMenu, setOpenRowMenu] = useState(false);
  const [openColMenu, setOpenColMenu] = useState(false);
  const [rowMenuSub, setRowMenuSub] = useState<TableHandleSubmenu>('none');
  const [colMenuSub, setColMenuSub] = useState<TableHandleSubmenu>('none');

  const rowWrapRef = useRef<HTMLDivElement>(null);
  const colWrapRef = useRef<HTMLDivElement>(null);
  const rowGripRef = useRef<HTMLButtonElement>(null);
  const colGripRef = useRef<HTMLButtonElement>(null);
  const rowColorBtnRef = useRef<HTMLButtonElement>(null);
  const rowAlignBtnRef = useRef<HTMLButtonElement>(null);
  const colColorBtnRef = useRef<HTMLButtonElement>(null);
  const colAlignBtnRef = useRef<HTMLButtonElement>(null);
  const rowMainMenuFloatRef = useRef<HTMLDivElement | null>(null);
  const rowSubMenuFloatRef = useRef<HTMLDivElement | null>(null);
  const colMainMenuFloatRef = useRef<HTMLDivElement | null>(null);
  const colSubMenuFloatRef = useRef<HTMLDivElement | null>(null);
  const layoutSnapshotRef = useRef<Layout | null>(null);

  const closeMenus = useCallback(() => {
    setOpenRowMenu(false);
    setOpenColMenu(false);
    setRowMenuSub('none');
    setColMenuSub('none');
  }, []);

  useLayoutEffect(() => {
    menusOpenRef.current = openRowMenu || openColMenu;
  }, [openRowMenu, openColMenu]);

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
    portalEl instanceof HTMLElement ? portalEl : typeof document !== 'undefined' ? document.body : null;

  useEffect(() => {
    if (!openRowMenu && !openColMenu) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (rowWrapRef.current?.contains(t)) return;
      if (colWrapRef.current?.contains(t)) return;
      if (rowMainMenuFloatRef.current?.contains(t)) return;
      if (rowSubMenuFloatRef.current?.contains(t)) return;
      if (colMainMenuFloatRef.current?.contains(t)) return;
      if (colSubMenuFloatRef.current?.contains(t)) return;
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
      const view = getPmView(editor);
      if (!view || !editor.isEditable) return;

      const menusOpen = menusOpenRef.current;
      let hit: Element | null = null;
      try {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        hit = el instanceof Element ? el : null;
      } catch {
        hit = null;
      }

      const outside = !hit || !view.dom.contains(hit);
      const inHandle = Boolean(hit?.closest('.bn-table-handle'));
      const inExtend = Boolean(hit?.closest('.bn-extend-button'));
      const inMenu = Boolean(hit?.closest('.bn-table-handle-menu'));
      const tw = hit?.closest('.tableWrapper') ?? null;
      const inOurTw = Boolean(tw && view.dom.contains(tw));

      let d = outside ? null : cellDomAtPoint(editor, e.clientX, e.clientY);
      if (d) lastTableDomRef.current = d;
      else if (inOurTw && tw instanceof HTMLElement) {
        const last = lastTableDomRef.current;
        const lastWrap = last?.table.closest('.tableWrapper');
        if (last && lastWrap && (lastWrap === tw || tw.contains(lastWrap))) d = last;
        else {
          const fc = tw.querySelector('td, th');
          if (fc instanceof HTMLTableCellElement) {
            const table = fc.closest('table') as HTMLElement | null;
            const row = fc.parentElement as HTMLTableRowElement | null;
            if (table && row) {
              d = { cell: fc, table, row };
              lastTableDomRef.current = d;
            }
          }
        }
      }

      const wantsChrome = inHandle || inExtend || inMenu || inOurTw;
      const nextDom =
        !wantsChrome && !menusOpen
          ? null
          : (d ??
            lastTableDomRef.current ??
            (menusOpen && isInTable(editor.state) ? cellDom(editor) : null));

      let nextGrid: { row: number; col: number; map: TableMap } | null = null;
      if (nextDom?.cell instanceof HTMLTableCellElement) {
        nextGrid = readGridForDomCell(editor, nextDom.cell);
      }
      if (!nextGrid && nextDom && isInTable(editor.state)) {
        try {
          nextGrid = readGrid(editor);
        } catch {
          nextGrid = null;
        }
      }

      domRef.current = nextDom;
      gridRef.current = nextGrid;

      if (!menusOpen) {
        setTableLayoutDom((prev) => {
          if (prev?.cell === nextDom?.cell && prev?.table === nextDom?.table) return prev;
          return nextDom;
        });
      }

      const t = nextDom?.table;
      const g = nextGrid;

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

  if (!dom || !grid || !layout) return null;

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
            ref={rowGripRef}
            type='button'
            className={cn('bn-table-handle bn-table-handle-row bn-table-handle-not-draggable')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpenColMenu(false);
              setColMenuSub('none');
              setOpenRowMenu((v) => {
                const next = !v;
                if (next) setRowMenuSub('none');
                return next;
              });
            }}
            aria-label='Row'
            aria-expanded={openRowMenu}
            aria-haspopup='menu'
          >
            <MdDragIndicator size={16} />
          </button>
          <TableHandleFloatingMenu
            open={openRowMenu}
            anchorEl={rowGripRef.current}
            className={tableHandleMenuSurfaceClass}
            zIndex={TABLE_HANDLE_MENU_Z}
            floatingRef={rowMainMenuFloatRef}
          >
            <button
              type='button'
              role='menuitem'
              disabled={grid.row <= 0}
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (moveTableRow(editor, 'up')) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiArrowUpLine size={16} />
              </span>
              Move row up
            </button>
            <button
              type='button'
              role='menuitem'
              disabled={grid.row >= grid.map.height - 1}
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (moveTableRow(editor, 'down')) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiArrowDownLine size={16} />
              </span>
              Move row down
            </button>
            <div className={tableMenuDivider} />
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().addRowBefore().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiInsertRowTop size={16} />
              </span>
              Insert row above
            </button>
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().addRowAfter().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiInsertRowBottom size={16} />
              </span>
              Insert row below
            </button>
            <div className={tableMenuDivider} />
            <button
              ref={rowColorBtnRef}
              type='button'
              role='menuitem'
              aria-expanded={rowMenuSub === 'color'}
              className={cn(tableMenuItemClass, rowMenuSub === 'color' && 'bg-background-default-secondary')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setRowMenuSub((s) => (s === 'color' ? 'none' : 'color'))}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiPaletteLine size={16} />
              </span>
              Color
              <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
            </button>
            <TableHandleFloatingSubmenu
              open={rowMenuSub === 'color'}
              anchorEl={rowColorBtnRef.current}
              className='outline-none'
              zIndex={TABLE_HANDLE_SUBMENU_Z}
              floatingRef={rowSubMenuFloatRef}
            >
              <TextColorPalettePanel
                editor={editor}
                tableScope={{ axis: 'row', index: grid.row }}
                onAfterPick={closeMenus}
              />
            </TableHandleFloatingSubmenu>
            <button
              ref={rowAlignBtnRef}
              type='button'
              role='menuitem'
              aria-expanded={rowMenuSub === 'align'}
              className={cn(tableMenuItemClass, rowMenuSub === 'align' && 'bg-background-default-secondary')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setRowMenuSub((s) => (s === 'align' ? 'none' : 'align'))}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <BlockIndentAlignIcon size={16} />
              </span>
              {'Indent & align'}
              <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
            </button>
            <TableHandleFloatingSubmenu
              open={rowMenuSub === 'align'}
              anchorEl={rowAlignBtnRef.current}
              className={tableMenuSubPanelSurfaceClass}
              zIndex={TABLE_HANDLE_SUBMENU_Z}
              floatingRef={rowSubMenuFloatRef}
            >
              <p className={blockMenuLabelClass}>Align</p>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableRowCellAlign(editor, grid.row, 'left');
                  closeMenus();
                }}
              >
                <RiAlignLeft size={15} className='shrink-0 text-text-default-tertiary' />
                Align left
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableRowCellAlign(editor, grid.row, 'center');
                  closeMenus();
                }}
              >
                <RiAlignCenter size={15} className='shrink-0 text-text-default-tertiary' />
                Align center
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableRowCellAlign(editor, grid.row, 'right');
                  closeMenus();
                }}
              >
                <RiAlignRight size={15} className='shrink-0 text-text-default-tertiary' />
                Align right
              </button>
              <p className={blockMenuLabelClass}>Indent</p>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableSinkOrLift(editor, 'sink', closeMenus)}
              >
                <RiIndentIncrease size={15} className='shrink-0 text-text-default-tertiary' />
                Increase indent
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableSinkOrLift(editor, 'lift', closeMenus)}
              >
                <RiIndentDecrease size={15} className='shrink-0 text-text-default-tertiary' />
                Decrease indent
              </button>
            </TableHandleFloatingSubmenu>
            <div className={tableMenuDivider} />
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (duplicateTableRow(editor, grid.row)) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiFileCopy2Line size={16} />
              </span>
              Duplicate row
            </button>
            <button
              type='button'
              role='menuitem'
              className={cn(tableMenuItemClass, 'text-destructive-base hover:bg-destructive-muted/10')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().deleteRow().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-current'>
                <RiDeleteBin6Line size={16} className='opacity-80' />
              </span>
              Delete row
            </button>
          </TableHandleFloatingMenu>
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
            ref={colGripRef}
            type='button'
            className={cn('bn-table-handle bn-table-handle-col bn-table-handle-not-draggable')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setOpenRowMenu(false);
              setRowMenuSub('none');
              setOpenColMenu((v) => {
                const next = !v;
                if (next) setColMenuSub('none');
                return next;
              });
            }}
            aria-label='Column'
            aria-expanded={openColMenu}
            aria-haspopup='menu'
          >
            <MdDragIndicator size={16} />
          </button>
          <TableHandleFloatingMenu
            open={openColMenu}
            anchorEl={colGripRef.current}
            className={tableHandleMenuSurfaceClass}
            zIndex={TABLE_HANDLE_MENU_Z}
            floatingRef={colMainMenuFloatRef}
          >
            <button
              type='button'
              role='menuitem'
              disabled={grid.col <= 0}
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (moveTableColumn(editor, 'left')) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiArrowLeftLine size={16} />
              </span>
              Move column left
            </button>
            <button
              type='button'
              role='menuitem'
              disabled={grid.col >= grid.map.width - 1}
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (moveTableColumn(editor, 'right')) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiArrowRightLine size={16} />
              </span>
              Move column right
            </button>
            <div className={tableMenuDivider} />
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().addColumnBefore().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiInsertColumnLeft size={16} />
              </span>
              Insert column left
            </button>
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().addColumnAfter().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiInsertColumnRight size={16} />
              </span>
              Insert column right
            </button>
            <div className={tableMenuDivider} />
            <button
              ref={colColorBtnRef}
              type='button'
              role='menuitem'
              aria-expanded={colMenuSub === 'color'}
              className={cn(tableMenuItemClass, colMenuSub === 'color' && 'bg-background-default-secondary')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setColMenuSub((s) => (s === 'color' ? 'none' : 'color'))}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiPaletteLine size={16} />
              </span>
              Color
              <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
            </button>
            <TableHandleFloatingSubmenu
              open={colMenuSub === 'color'}
              anchorEl={colColorBtnRef.current}
              className='outline-none'
              zIndex={TABLE_HANDLE_SUBMENU_Z}
              floatingRef={colSubMenuFloatRef}
            >
              <TextColorPalettePanel
                editor={editor}
                tableScope={{ axis: 'column', index: grid.col }}
                onAfterPick={closeMenus}
              />
            </TableHandleFloatingSubmenu>
            <button
              ref={colAlignBtnRef}
              type='button'
              role='menuitem'
              aria-expanded={colMenuSub === 'align'}
              className={cn(tableMenuItemClass, colMenuSub === 'align' && 'bg-background-default-secondary')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setColMenuSub((s) => (s === 'align' ? 'none' : 'align'))}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <BlockIndentAlignIcon size={16} />
              </span>
              {'Indent & align'}
              <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
            </button>
            <TableHandleFloatingSubmenu
              open={colMenuSub === 'align'}
              anchorEl={colAlignBtnRef.current}
              className={tableMenuSubPanelSurfaceClass}
              zIndex={TABLE_HANDLE_SUBMENU_Z}
              floatingRef={colSubMenuFloatRef}
            >
              <p className={blockMenuLabelClass}>Align</p>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableColumnCellAlign(editor, grid.col, 'left');
                  closeMenus();
                }}
              >
                <RiAlignLeft size={15} className='shrink-0 text-text-default-tertiary' />
                Align left
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableColumnCellAlign(editor, grid.col, 'center');
                  closeMenus();
                }}
              >
                <RiAlignCenter size={15} className='shrink-0 text-text-default-tertiary' />
                Align center
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setTableColumnCellAlign(editor, grid.col, 'right');
                  closeMenus();
                }}
              >
                <RiAlignRight size={15} className='shrink-0 text-text-default-tertiary' />
                Align right
              </button>
              <p className={blockMenuLabelClass}>Indent</p>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableSinkOrLift(editor, 'sink', closeMenus)}
              >
                <RiIndentIncrease size={15} className='shrink-0 text-text-default-tertiary' />
                Increase indent
              </button>
              <button
                type='button'
                role='menuitem'
                className={tableMenuItemClass}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runTableSinkOrLift(editor, 'lift', closeMenus)}
              >
                <RiIndentDecrease size={15} className='shrink-0 text-text-default-tertiary' />
                Decrease indent
              </button>
            </TableHandleFloatingSubmenu>
            <div className={tableMenuDivider} />
            <button
              type='button'
              role='menuitem'
              className={tableMenuItemClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (duplicateTableColumn(editor, grid.col)) closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                <RiFileCopy2Line size={16} />
              </span>
              Duplicate column
            </button>
            <button
              type='button'
              role='menuitem'
              className={cn(tableMenuItemClass, 'text-destructive-base hover:bg-destructive-muted/10')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                editor.chain().focus().deleteColumn().run();
                closeMenus();
              }}
            >
              <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-current'>
                <RiDeleteBin6Line size={16} className='opacity-80' />
              </span>
              Delete column
            </button>
          </TableHandleFloatingMenu>
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

export default TableHandles;
