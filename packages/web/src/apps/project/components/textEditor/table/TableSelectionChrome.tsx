import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { isInTable, selectedRect, type TableMap } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { selectCellsInclusiveRect } from '@/apps/project/components/textEditor/table/tableSelectionHelpers';

type TableRect = ReturnType<typeof selectedRect>;

const getPmView = (editor: Editor): EditorView | null =>
  (editor as unknown as { editorView: EditorView | null }).editorView;

const unionClientRects = (elements: HTMLElement[]): DOMRect | null => {
  if (!elements.length) return null;
  const first = elements[0].getBoundingClientRect();
  let left = first.left;
  let top = first.top;
  let right = first.right;
  let bottom = first.bottom;
  for (let i = 1; i < elements.length; i += 1) {
    const r = elements[i].getBoundingClientRect();
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
};

const collectCellElements = (view: EditorView, r: TableRect) => {
  const cells: HTMLElement[] = [];
  for (let row = r.top; row < r.bottom; row += 1) {
    for (let col = r.left; col < r.right; col += 1) {
      const pos = r.tableStart + r.map.map[row * r.map.width + col];
      const dom = view.nodeDOM(pos);
      const el = dom instanceof HTMLElement ? dom.closest('td, th') : null;
      if (el instanceof HTMLElement) cells.push(el);
    }
  }
  return cells;
};

type OverlayState = {
  rect: DOMRect;
  showDot: boolean;
  showFrame: boolean;
};

const CHROME_Z = 63;

/**
 * Table cell outline for caret + multi-cell selection, and an east-edge dot to
 * extend `CellSelection` by dragging (same interaction model as common doc editors).
 */
const TableSelectionChrome = ({ editor }: { editor: Editor }) => {
  const tick = useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const dragRef = useRef<{
    tableStart: number;
    map: TableMap;
    row0: number;
    row1: number;
    col0: number;
    col1: number;
  } | null>(null);

  const syncOverlay = useCallback(() => {
    const view = getPmView(editor);
    if (!view || editor.isDestroyed) {
      setOverlay(null);
      return;
    }
    if (!isInTable(editor.state)) {
      setOverlay(null);
      return;
    }
    let r: ReturnType<typeof selectedRect>;
    try {
      r = selectedRect(editor.state);
    } catch {
      setOverlay(null);
      return;
    }
    const cells = collectCellElements(view, r);
    const rect = unionClientRects(cells);
    if (!rect) {
      setOverlay(null);
      return;
    }
    setOverlay({
      rect,
      showDot: true,
      showFrame: true,
    });
  }, [editor]);

  useLayoutEffect(() => {
    void tick;
    syncOverlay();
  }, [tick, syncOverlay]);

  useEffect(() => {
    const onViewportChanged = () => syncOverlay();
    window.addEventListener('scroll', onViewportChanged, true);
    window.addEventListener('resize', onViewportChanged);
    const view = getPmView(editor);
    const scrollRoot =
      view?.dom instanceof HTMLElement
        ? (view.dom.closest('.breatic-editor-scroll') as HTMLElement | null)
        : null;
    scrollRoot?.addEventListener('scroll', onViewportChanged, { passive: true });
    return () => {
      window.removeEventListener('scroll', onViewportChanged, true);
      window.removeEventListener('resize', onViewportChanged);
      scrollRoot?.removeEventListener('scroll', onViewportChanged);
    };
  }, [editor, syncOverlay]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const view = getPmView(editor);
    if (!view?.dom || !(view.dom instanceof HTMLElement)) return;

    const editorDom = view.dom;
    const scrollRoot =
      (editorDom.closest('.breatic-editor-scroll') as HTMLElement | null) ??
      (editorDom.closest('.breatic-editor-wrapper') as HTMLElement | null);

    const ro = new ResizeObserver(() => {
      syncOverlay();
    });

    ro.observe(editorDom);
    if (scrollRoot) ro.observe(scrollRoot);
    editorDom.querySelectorAll('table').forEach((tableEl) => {
      if (tableEl instanceof HTMLElement) ro.observe(tableEl);
    });

    return () => {
      ro.disconnect();
    };
  }, [editor, syncOverlay, tick]);

  const onDotPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      let r: TableRect;
      try {
        r = selectedRect(editor.state);
      } catch {
        return;
      }
      dragRef.current = {
        tableStart: r.tableStart,
        map: r.map,
        row0: r.top,
        row1: r.bottom - 1,
        col0: r.left,
        col1: r.right - 1,
      };
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [editor],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const view = getPmView(editor);
      if (!view) return;
      let hit: Element | null = null;
      try {
        hit = document.elementFromPoint(e.clientX, e.clientY);
      } catch {
        return;
      }
      const cell = hit instanceof Element ? hit.closest('td, th') : null;
      if (!(cell instanceof HTMLTableCellElement) || !view.dom.contains(cell)) return;

      const table = cell.closest('table');
      if (!table || !view.dom.contains(table)) return;

      const tr = cell.parentElement as HTMLTableRowElement | null;
      if (!tr) return;
      const tableEl = cell.closest('table');
      if (!tableEl) return;
      const allRows = tableEl.querySelectorAll('tr');
      let row = -1;
      for (let i = 0; i < allRows.length; i += 1) {
        if (allRows[i] === tr) {
          row = i;
          break;
        }
      }
      if (row < 0) return;
      const col = Array.prototype.indexOf.call(tr.children, cell);
      if (col < 0) return;

      const top = Math.min(d.row0, d.row1, row);
      const bottom = Math.max(d.row0, d.row1, row);
      const left = Math.min(d.col0, d.col1, col);
      const right = Math.max(d.col0, d.col1, col);
      selectCellsInclusiveRect(editor, d.tableStart, d.map, top, left, bottom, right);
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [editor]);

  const view = getPmView(editor);
  const portalRoot =
    view?.dom instanceof HTMLElement
      ? (view.dom.closest('.breatic-editor-scroll') as HTMLElement | null) ??
        (view.dom.closest('.breatic-editor-wrapper') as HTMLElement | null)
      : null;

  if (!overlay || !portalRoot) return null;

  const { rect, showDot, showFrame } = overlay;
  const borderW = 2;
  const pad = borderW / 2;

  return createPortal(
    <div className='pointer-events-none' aria-hidden>
      {showFrame && (
        <div
          className='fixed rounded-sm'
          style={{
            zIndex: CHROME_Z,
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + borderW,
            height: rect.height + borderW,
            boxShadow: `inset 0 0 0 ${borderW}px var(--color-brand-base, #3563E9)`,
            pointerEvents: 'none',
          }}
        />
      )}
      {showDot && (
        <button
          type='button'
          className='fixed cursor-crosshair rounded-full border-0 p-0 outline-none'
          style={{
            zIndex: CHROME_Z + 1,
            width: 8,
            height: 8,
            left: rect.right - 4,
            top: rect.top + rect.height / 2 - 4,
            backgroundColor: 'var(--color-brand-base, #3563E9)',
            pointerEvents: 'auto',
            boxShadow: '0 0 0 1px var(--color-background-default-base, #fff)',
          }}
          aria-label='Extend cell selection'
          title='Drag to extend selection'
          onPointerDown={onDotPointerDown}
        />
      )}
    </div>,
    portalRoot,
  );
};

export default TableSelectionChrome;
