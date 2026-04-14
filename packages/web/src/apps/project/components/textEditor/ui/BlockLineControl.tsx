import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { MdDragIndicator } from 'react-icons/md';
import { RiAddLine, RiArrowRightSFill } from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import Tooltip from '@/components/base/tooltip';
import BlockTypeMenu from '@/apps/project/components/textEditor/formatting/BlockTypeMenu';
import {
  breaticSlashMenuKey,
  closeBreaticSlashMenu,
  openBreaticSlashMenu,
} from '@/apps/project/components/textEditor/slash/SlashMenuPlugin';
import {
  headingFoldArrowVisible,
  headingFoldKey,
  toggleHeadingFold,
} from '@/apps/project/components/textEditor/extensions/HeadingFoldExtension';
import { isMediaLikeBlockType } from '@/apps/project/components/textEditor/shared/MediaBlockTypes';
import { BREATIC_SUPPRESS_FORMAT_BUBBLE_META } from '@/apps/project/components/textEditor/extensions/FormatBubbleSuppressExtension';

interface BlockLineControlProps {
  editor: Editor;
}

/* ─── ProseMirror helpers ─────────────────────────────────────────── */

/**
 * Innermost line-level block for a resolved position.
 * Table chrome (`table` / `tableRow` / `tableCell`) is excluded so the gutter
 * anchors to content inside cells (BlockNote-style `blockContainer`), not the whole table.
 */
const getBlockStartPosFromResolved = ($pos: {
  depth: number;
  before: (d: number) => number;
  node: (d: number) => { type: { name: string } };
}): number | null => {
  for (let d = $pos.depth; d >= 1; d -= 1) {
    const name = $pos.node(d).type.name;
    if (
      name === 'paragraph' ||
      name === 'heading' ||
      name === 'blockquote' ||
      name === 'codeBlock' ||
      name === 'horizontalRule' ||
      name === 'image' ||
      name === 'video' ||
      name === 'audio' ||
      name === 'pendingImage' ||
      name === 'pendingVideo' ||
      name === 'pendingAudio' ||
      name === 'pendingFile' ||
      name === 'bulletList' ||
      name === 'orderedList' ||
      name === 'taskList' ||
      name === 'listItem' ||
      name === 'taskItem'
    ) {
      return $pos.before(d);
    }
  }
  if ($pos.depth >= 1) return $pos.before(1);
  return null;
};

const getTopLevelBlockStartAtDocPos = (doc: PMNode, pos: number): number | null => {
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  let offset = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    const child = doc.child(i);
    const start = offset;
    const end = start + child.nodeSize;
    if (safe >= start && safe < end) return start;
    offset = end;
  }
  return null;
};

const getBlockStartAtDocPos = (editor: Editor, pos: number): number | null => {
  const doc = editor.state.doc;
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  const fromResolved = getBlockStartPosFromResolved(doc.resolve(safe));
  if (fromResolved != null) return fromResolved;
  return getTopLevelBlockStartAtDocPos(doc, safe);
};

const getAncestorNodeStartByType = (doc: PMNode, pos: number, typeName: string): number | null => {
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safe);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if ($pos.node(d).type.name === typeName) return $pos.before(d);
  }
  return null;
};

/**
 * Keep table hover behavior as a single block (first-row handle), matching the
 * expected UX where side controls represent the table block, not each row.
 */
const normalizeBlockStartForTable = (editor: Editor, blockStart: number): number => {
  const tableStart = getAncestorNodeStartByType(editor.state.doc, blockStart + 1, 'table');
  return tableStart ?? blockStart;
};

/** End position after the inner block that starts at `blockStart` (insert new sibling after here). */
const getBlockEndPos = (editor: Editor, blockStart: number): number | null => {
  const doc = editor.state.doc;
  const $pos = doc.resolve(blockStart + 1);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if ($pos.before(d) === blockStart) return $pos.after(d);
  }
  return null;
};

/** Fallback when `getBlockEndPos` misses (e.g. stale `blockStart` vs resolve). */
const getBlockEndPosRobust = (editor: Editor, blockStart: number): number | null => {
  const fromInner = getBlockEndPos(editor, blockStart);
  if (fromInner != null) return fromInner;
  const doc = editor.state.doc;
  if (blockStart < 0 || blockStart > doc.content.size) return null;
  const $gap = doc.resolve(Math.min(blockStart, doc.content.size));
  const after = $gap.nodeAfter;
  if (after) return blockStart + after.nodeSize;
  return null;
};

/** Inner block node whose start position in the document is `blockStart`. */
const getInnerBlockNodeAtStart = (doc: PMNode, blockStart: number): PMNode | null => {
  const $pos = doc.resolve(blockStart + 1);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if ($pos.before(d) === blockStart) return $pos.node(d);
  }
  return null;
};

/**
 * Hovered line is already an empty paragraph/heading (placeholder “Enter text or type '/'…”):
 * Insert block should only open slash here, not add another line below.
 */
const isEmptyInsertLineBlock = (doc: PMNode, blockStart: number): boolean => {
  const node = getInnerBlockNodeAtStart(doc, blockStart);
  if (!node) return false;
  if (node.type.name === 'paragraph' || node.type.name === 'heading') {
    return node.textContent.trim().length === 0;
  }
  return false;
};

/** Top-level doc child range that contains the given inner-block position. */
const getTopLevelBlockRange = (doc: PMNode, innerBlockStart: number): { start: number; end: number } | null => {
  const safe = Math.min(Math.max(innerBlockStart + 1, 1), doc.content.size);
  const $pos = doc.resolve(safe);
  if ($pos.depth < 1) return null;
  return { start: $pos.before(1), end: $pos.after(1) };
};

/**
 * Move a slice [from, to) to insertPosOriginal in the document.
 * Uses ProseMirror mapping so positions stay valid after the delete.
 */
const moveDocRange = (editor: Editor, from: number, to: number, insertPosOriginal: number): boolean => {
  if (from >= to || insertPosOriginal < 0) return false;
  const { state, view } = editor;
  const { doc, tr } = state;
  if (to > doc.content.size || insertPosOriginal > doc.content.size) return false;
  if (insertPosOriginal > from && insertPosOriginal < to) return false;
  const slice = doc.slice(from, to);
  tr.delete(from, to);
  const pos = tr.mapping.map(insertPosOriginal);
  tr.insert(pos, slice.content);
  try {
    tr.setSelection(NodeSelection.create(tr.doc, pos));
  } catch {
    /* not all top-level nodes accept NodeSelection at insert boundary */
  }
  tr.setMeta(BREATIC_SUPPRESS_FORMAT_BUBBLE_META, true);
  view.dispatch(tr);
  return true;
};

const getEditorView = (editor: Editor) => {
  try {
    return editor.isDestroyed ? null : editor.view;
  } catch {
    return null;
  }
};

/**
 * Horizontal bounds for hit-testing and gutter `contentLeft` (BlockNote-style column).
 * Must use the ProseMirror root — `firstElementChild` is the *first block* (e.g. a wide
 * `tableWrapper`), so using it shifts every handle after a table is inserted.
 */
const getEditorInnerContentRect = (editorDom: HTMLElement): DOMRect => editorDom.getBoundingClientRect();

/** DOM for the block at `blockStart` — used for handle position and right-edge refinement. */
const resolveBlockDomForHandle = (view: EditorView, editorDom: HTMLElement, blockStart: number): HTMLElement | null => {
  const tryDomAtPos = (pos: number): HTMLElement | null => {
    try {
      const domAt = view.domAtPos(pos);
      let el = domAt.node as HTMLElement;
      if (el.nodeType === Node.TEXT_NODE) el = el.parentElement as HTMLElement;
      while (el && el.parentElement !== editorDom) {
        el = el.parentElement as HTMLElement;
      }
      return el && el !== editorDom ? el : null;
    } catch {
      return null;
    }
  };

  for (const probe of [blockStart, blockStart + 1]) {
    const raw = view.nodeDOM(probe);
    const asEl = raw instanceof HTMLElement ? raw : raw?.parentElement ?? null;
    if (asEl && editorDom.contains(asEl)) return asEl;
  }

  return tryDomAtPos(blockStart + 1) ?? tryDomAtPos(blockStart);
};

const getTableFirstRowRect = (tableBlockDom: HTMLElement): DOMRect | null => {
  const firstCell = tableBlockDom.querySelector(
    'table tr:first-child > th, table tr:first-child > td, tr:first-child > th, tr:first-child > td',
  ) as HTMLElement | null;
  if (firstCell) return firstCell.getBoundingClientRect();

  const firstRow = tableBlockDom.querySelector('table tr:first-child, tr:first-child') as HTMLElement | null;
  if (firstRow) return firstRow.getBoundingClientRect();

  return null;
};

/**
 * From a hit target, walk up and keep the innermost recognized block (largest ProseMirror depth).
 * On equal depth, prefer the candidate anchored on a DOM node closer to the hit (`gen` smaller),
 * so e.g. `td`/`p` beats outer wrappers that map to the same depth.
 */
const domToInnermostBlockStart = (view: EditorView, editor: Editor, startEl: Element): number | null => {
  let el: Element | null = startEl;
  let best: number | null = null;
  let bestDepth = -1;
  let bestGen = Number.POSITIVE_INFINITY;
  let gen = 0;
  const doc = view.state.doc;
  while (el && el !== view.dom) {
    if (el instanceof HTMLElement) {
      try {
        const pos = view.posAtDOM(el, 0);
        const bs = getBlockStartAtDocPos(editor, pos);
        if (bs != null) {
          const safePos = Math.min(Math.max(bs + 1, 1), doc.content.size);
          const depth = doc.resolve(safePos).depth;
          if (depth > bestDepth || (depth === bestDepth && gen < bestGen)) {
            bestDepth = depth;
            bestGen = gen;
            best = bs;
          }
        }
      } catch {
        /* not mapped to doc */
      }
    }
    gen += 1;
    el = el.parentElement;
  }
  return best;
};

const getBlockStartFromElementsAt = (
  view: EditorView,
  editor: Editor,
  clientX: number,
  clientY: number,
): number | null => {
  const root = view.dom.ownerDocument ?? document;
  let list: Element[];
  try {
    list = root.elementsFromPoint(clientX, clientY) as Element[];
  } catch {
    return null;
  }
  const editorDom = view.dom as HTMLElement;
  for (const item of list) {
    if (!(item instanceof Element)) continue;
    if (!editorDom.contains(item)) continue;
    const bs = domToInnermostBlockStart(view, editor, item);
    if (bs != null) return bs;
  }
  return null;
};

const getBlockStartFromMousePos = (editor: Editor, clientX: number, clientY: number): number | null => {
  const v = getEditorView(editor);
  if (!v) return null;
  const editorDom = v.dom as HTMLElement;
  const box = getEditorInnerContentRect(editorDom);
  const clampedX = Math.min(Math.max(box.left + 10, clientX), box.right - 10);

  // Prefer PM geometry first: inside tables, `elementsFromPoint` often hits wrappers / chrome
  // and resolves to the wrong row; `posAtCoords` tracks the caret position reliably.
  const coords = v.posAtCoords({ left: clampedX, top: clientY });
  let bs = coords ? getBlockStartAtDocPos(editor, coords.pos) : null;
  if (bs == null) bs = getBlockStartFromElementsAt(v, editor, clampedX, clientY);
  if (bs == null) return null;
  bs = normalizeBlockStartForTable(editor, bs);

  const refDom = resolveBlockDomForHandle(v, editorDom, bs);
  const blockRect = refDom ? refDom.getBoundingClientRect() : null;
  if (blockRect) {
    // Ignore whitespace above/below a block: don't snap side controls to nearest node.
    if (clientY < blockRect.top - 2 || clientY > blockRect.bottom + 2) return null;
  }

  const hitNode = getInnerBlockNodeAtStart(editor.state.doc, bs);
  if (hitNode?.type.name === 'table') return bs;

  if (hitNode && isMediaLikeBlockType(hitNode.type.name)) {
    return bs;
  }

  if (blockRect && blockRect.width >= 4) {
    const refineX = Math.min(Math.max(blockRect.left + 1, blockRect.right - 10), blockRect.right - 1);
    const refined = getBlockStartFromElementsAt(v, editor, refineX, clientY);
    if (refined != null) return normalizeBlockStartForTable(editor, refined);
  }
  return bs;
};

const getEditorPortalHost = (editor: Editor): HTMLElement | null => {
  const v = getEditorView(editor);
  if (!v) return null;
  return (v.dom as HTMLElement).closest('.breatic-editor-body');
};

const getBlockLinePortalHost = (editor: Editor): HTMLElement | null => {
  const v = getEditorView(editor);
  if (!v) return null;
  const dom = v.dom as HTMLElement;
  return (dom.closest('.breatic-editor-wrapper') as HTMLElement | null) ?? dom.closest('.breatic-editor-body');
};

/** Keep drag/insert/fold gutter controls below the text bubble toolbar. */
const BLOCK_LINE_CONTROL_Z = 60;

const preventEditorNativeDragStart = (e: DragEvent): void => {
  e.preventDefault();
};

type PointerTrackingArgs = {
  editor: Editor;
  editorDom: HTMLElement;
  rootRef: RefObject<HTMLDivElement | null>;
  hoverBlockStartRef: RefObject<number | null>;
  lastHoveredBlockStartRef: RefObject<number | null>;
  menuOpenRef: RefObject<boolean>;
  /** True while block handle menu is open — synced on pointer events before React re-renders. */
  blockTypeMenuOpenSyncRef: RefObject<boolean>;
  updatePosition: () => void;
  /** Component-level ref shared with the editor update handler for re-detection after doc changes. */
  lastMousePosRef: RefObject<{ x: number; y: number }>;
};

const attachGlobalPointerMoveForBlockHover = (args: PointerTrackingArgs): (() => void) => {
  const {
    editor,
    editorDom,
    rootRef,
    hoverBlockStartRef,
    lastHoveredBlockStartRef,
    menuOpenRef,
    blockTypeMenuOpenSyncRef,
    updatePosition,
    lastMousePosRef,
  } = args;

  let raf = 0;
  let pendingEvent: PointerEvent | null = null;
  let clearHoverTimer: number | null = null;
  // Use the component-level ref object directly so the editor `update` handler
  // can read the latest mouse position for block re-detection after doc changes.
  const lastPointer = lastMousePosRef.current;

  const cancelClearHover = () => {
    if (clearHoverTimer != null) {
      window.clearTimeout(clearHoverTimer);
      clearHoverTimer = null;
    }
  };

  /** True when cursor viewport coords are within `ed`'s bounding rect. */
  const isCursorWithinEditorBBox = (x: number, y: number, ed: HTMLElement): boolean => {
    const r = ed.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const scheduleClearHover = () => {
    if (clearHoverTimer != null) return;
    clearHoverTimer = window.setTimeout(() => {
      clearHoverTimer = null;
      const root = rootRef.current;
      const v = getEditorView(editor);
      const ed = v?.dom as HTMLElement | undefined;
      // Don't clear if cursor moved back into editor area or over the handle
      if (ed && isCursorWithinEditorBBox(lastPointer.x, lastPointer.y, ed)) return;
      const t = document.elementFromPoint(lastPointer.x, lastPointer.y);
      if (t && root && root.contains(t)) return;
      if (menuOpenRef.current || blockTypeMenuOpenSyncRef.current) return;
      hoverBlockStartRef.current = null;
      lastHoveredBlockStartRef.current = null;
      updatePosition();
    }, 100);
  };

  const runFromEvent = (e: PointerEvent) => {
    if (menuOpenRef.current || blockTypeMenuOpenSyncRef.current) return;

    const v = getEditorView(editor);
    if (!v) return;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;

    // Use e.target (the actual dispatched-to element) for reliable overlay detection.
    // document.elementFromPoint (singular) only returns the topmost element and would
    // incorrectly treat the BubbleMenu (appended to view.dom.parentElement) as "not editor"
    // even when the cursor is physically over editor content behind it.
    const target = e.target as Element | null;
    const root = rootRef.current;
    const overHandle = Boolean(target && root?.contains(target));

    if (overHandle) {
      cancelClearHover();
      if (hoverBlockStartRef.current == null && lastHoveredBlockStartRef.current != null) {
        hoverBlockStartRef.current = lastHoveredBlockStartRef.current;
      }
      updatePosition();
      return;
    }

    // Check whether the cursor is within the ProseMirror element's bounding box.
    // This is the key fix: when the BubbleMenu / any floating UI overlay (which lives
    // in view.dom.parentElement, outside editorDom) intercepts the pointer, the cursor
    // is still visually "in the editor". We must not clear hover in that case.
    const withinEditorBBox = isCursorWithinEditorBBox(e.clientX, e.clientY, editorDom);

    if (!withinEditorBBox) {
      // Cursor left the editor area entirely — schedule a delayed clear
      scheduleClearHover();
      return;
    }

    // Cursor is within the editor bounding box.
    const overEditorContent = Boolean(target && editorDom.contains(target));

    if (!overEditorContent) {
      // Cursor is over a floating UI overlay (BubbleMenu, TableHandles, etc.)
      // that lives inside the editor's visual area but outside editorDom.
      // Keep the current hover position frozen — do NOT clear or update.
      // This matches BlockNote's SideMenu behaviour: the side menu stays at
      // the last known block while the formatting toolbar is being used.
      cancelClearHover();
      return;
    }

    // Cursor is directly over editable content — detect and update the hovered block.
    cancelClearHover();

    const bs = getBlockStartFromMousePos(editor, e.clientX, e.clientY);
    if (bs != null) {
      hoverBlockStartRef.current = bs;
      lastHoveredBlockStartRef.current = bs;
    }
    updatePosition();
  };

  const onPointerMove = (e: PointerEvent) => {
    pendingEvent = e;
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev = pendingEvent;
      pendingEvent = null;
      if (ev) runFromEvent(ev);
    });
  };

  document.addEventListener('pointermove', onPointerMove, { capture: true });
  return () => {
    document.removeEventListener('pointermove', onPointerMove, { capture: true });
    cancelClearHover();
    if (raf !== 0) cancelAnimationFrame(raf);
  };
};

type ScrollAttachArgs = {
  editor: Editor;
  updatePosition: () => void;
  scrollIdleTimerRef: RefObject<number | null>;
  menuOpenRef: RefObject<boolean>;
  setIsScrollAnimSuppressed: (v: boolean) => void;
};

const attachEditorWrapperScrollAndResize = (args: ScrollAttachArgs): (() => void) | undefined => {
  const { editor, updatePosition, scrollIdleTimerRef, menuOpenRef, setIsScrollAnimSuppressed } = args;
  const view = getEditorView(editor);
  if (!view) return undefined;
  const editorDom = view.dom as HTMLElement;
  const wrap = editorDom.closest('.breatic-editor-wrapper');
  if (!wrap) return undefined;

  const onScroll = () => {
    setIsScrollAnimSuppressed(true);
    if (scrollIdleTimerRef.current != null) window.clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setIsScrollAnimSuppressed(false);
    }, 100);
    if (!menuOpenRef.current) updatePosition();
  };

  wrap.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', updatePosition);
  return () => {
    wrap.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', updatePosition);
    if (scrollIdleTimerRef.current != null) window.clearTimeout(scrollIdleTimerRef.current);
  };
};

type DropIndicatorState = {
  top: number;
  left: number;
  width: number;
  mode: 'fixed' | 'absolute';
};

type DragDropAttachArgs = {
  editor: Editor;
  dragPayloadRef: RefObject<{ from: number; to: number } | null>;
  setDropIndicator: React.Dispatch<React.SetStateAction<DropIndicatorState | null>>;
  setDragging: (v: boolean) => void;
};

type NonNullEditorView = NonNullable<ReturnType<typeof getEditorView>>;

const attachDocumentBlockDragDrop = (args: DragDropAttachArgs): (() => void) | undefined => {
  const { editor, dragPayloadRef, setDropIndicator, setDragging } = args;
  const maybeView = getEditorView(editor);
  if (!maybeView) return undefined;
  const pmView: NonNullEditorView = maybeView;
  const dom = pmView.dom as HTMLElement;

  const clearDragUi = () => {
    dragPayloadRef.current = null;
    setDropIndicator(null);
    setDragging(false);
  };

  const onDragOver = (e: DragEvent) => {
    if (!dragPayloadRef.current) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const edRect = dom.getBoundingClientRect();
    if (e.clientY < edRect.top - 40 || e.clientY > edRect.bottom + 40) {
      setDropIndicator(null);
      return;
    }

    const innerStart = getBlockStartFromMousePos(editor, e.clientX, e.clientY);
    if (innerStart == null) {
      setDropIndicator(null);
      return;
    }

    const tgt = getTopLevelBlockRange(editor.state.doc, innerStart);
    if (!tgt) {
      setDropIndicator(null);
      return;
    }

    // nodeDOM can return a Text node — only HTMLElement has getBoundingClientRect
    const rawNode = pmView.nodeDOM(tgt.start);
    const nodeDomEl = rawNode instanceof HTMLElement ? rawNode : null;
    if (!nodeDomEl) {
      setDropIndicator(null);
      return;
    }

    const host = dom.closest('.breatic-editor-body') as HTMLElement | null;
    const r = nodeDomEl.getBoundingClientRect();
    const placeAfter = e.clientY >= r.top + r.height / 2;
    const lineTop = placeAfter ? r.bottom : r.top;
    if (!host) {
      setDropIndicator({ top: lineTop, left: r.left, width: r.width, mode: 'fixed' });
      return;
    }
    const hr = host.getBoundingClientRect();
    setDropIndicator({
      top: lineTop - hr.top,
      left: r.left - hr.left,
      width: r.width,
      mode: 'absolute',
    });
  };

  const onDrop = (e: DragEvent) => {
    const payload = dragPayloadRef.current;
    if (!payload) return;
    e.preventDefault();

    const innerStart = getBlockStartFromMousePos(editor, e.clientX, e.clientY);
    if (innerStart == null) {
      clearDragUi();
      return;
    }

    const tgt = getTopLevelBlockRange(editor.state.doc, innerStart);
    if (!tgt) {
      clearDragUi();
      return;
    }

    const { from: srcFrom, to: srcTo } = payload;
    if (tgt.start === srcFrom && tgt.end === srcTo) {
      clearDragUi();
      return;
    }

    const rawDropNode = pmView.nodeDOM(tgt.start);
    const nodeDomEl = rawDropNode instanceof HTMLElement ? rawDropNode : null;
    let placeAfter = false;
    if (nodeDomEl) {
      const r = nodeDomEl.getBoundingClientRect();
      placeAfter = e.clientY >= r.top + r.height / 2;
    }

    moveDocRange(editor, srcFrom, srcTo, placeAfter ? tgt.end : tgt.start);
    clearDragUi();
    editor.chain().focus().run();
  };

  const onWinDragEnd = () => {
    if (dragPayloadRef.current) clearDragUi();
  };

  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  window.addEventListener('dragend', onWinDragEnd);

  return () => {
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('drop', onDrop);
    window.removeEventListener('dragend', onWinDragEnd);
  };
};

const applyBlockDragStart = (
  e: ReactDragEvent<HTMLSpanElement>,
  editor: Editor,
  blockStart: number,
  dragPayloadRef: RefObject<{ from: number; to: number } | null>,
  onAfterPayloadSet: () => void,
): boolean => {
  const view = getEditorView(editor);
  if (!view) return false;

  const range = getTopLevelBlockRange(editor.state.doc, blockStart);
  if (!range || range.end <= range.start) return false;

  dragPayloadRef.current = { from: range.start, to: range.end };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');

  let blockDom = view.nodeDOM(range.start) as HTMLElement | null;
  if (!blockDom || !view.dom.contains(blockDom)) {
    try {
      const domAt = view.domAtPos(range.start + 1);
      let el = domAt.node as HTMLElement;
      if (el.nodeType === Node.TEXT_NODE) el = el.parentElement as HTMLElement;
      while (el && el.parentElement !== view.dom) el = el.parentElement as HTMLElement;
      blockDom = el && el !== view.dom ? el : null;
    } catch {
      /* ignore */
    }
  }
  if (blockDom) {
    e.dataTransfer.setDragImage(blockDom, 24, Math.max(4, blockDom.offsetHeight / 2));
  }

  try {
    const sel = NodeSelection.create(editor.state.doc, range.start);
    editor.view.dispatch(editor.state.tr.setSelection(sel));
  } catch {
    /* ignore if pos is invalid */
  }

  onAfterPayloadSet();
  return true;
};

const POS_EPS = 0.75;

/** Gutter control size (matches `h-6 w-6` + buttons). */
const GUTTER_BTN_PX = 24;
const GUTTER_FLEX_GAP_PX = 0;
/** Space between gutter cluster and prose inner edge. */
const GUTTER_EDGE_GAP_PX = 8;

const gutterClusterWidthPx = (showFold: boolean): number => {
  const n = showFold ? 3 : 2;
  return n * GUTTER_BTN_PX + (n - 1) * GUTTER_FLEX_GAP_PX;
};

type HandleBarPos = { top: number; left: number; position: 'fixed' | 'absolute'; blockStart: number };

type SideMenuState = 'none' | 'handle';

const BlockLineControl = ({ editor }: BlockLineControlProps) => {
  const [menuOpen, setMenuOpen] = useState<SideMenuState>('none');

  /** Slash palette opened from + button (same list as `/`). */
  const slashFromInsertOpen = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const pm = breaticSlashMenuKey.getState(ed.state);
      return Boolean(pm && !pm.deleteTriggerCharacter);
    },
  });

  /** Subscribe so fold chevron updates when plugin state toggles without doc change. */
  const headingFoldPluginState = useEditorState({
    editor,
    selector: ({ editor: ed }) => headingFoldKey.getState(ed.state),
  });

  const [dragging, setDragging] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicatorState | null>(null);
  const [isScrollAnimSuppressed, setIsScrollAnimSuppressed] = useState(false);
  const [pos, setPos] = useState<HandleBarPos | null>(null);

  /** Avoid setState when coordinates unchanged — prevents update ⟷ transaction loops with useLayoutEffect. */
  const setPosStable = useCallback((next: HandleBarPos | null) => {
    setPos((prev) => {
      if (next === null) return prev === null ? prev : null;
      if (prev === null) return next;
      if (
        prev.position === next.position &&
        prev.blockStart === next.blockStart &&
        Math.abs(prev.top - next.top) < POS_EPS &&
        Math.abs(prev.left - next.left) < POS_EPS
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLSpanElement>(null);
  const blockTypeMenuMainFloatRef = useRef<HTMLDivElement | null>(null);
  const blockTypeMenuSubFloatRef = useRef<HTMLDivElement | null>(null);
  const dragPayloadRef = useRef<{ from: number; to: number } | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const displayedBlockStartRef = useRef<number | null>(null);
  /** Frozen when the drag-handle menu opens — same role as BlockNote `SideMenuExtension.state.block` (stable delete/turn-into target). */
  const frozenHandleMenuBlockStartRef = useRef<number | null>(null);
  const hoverBlockStartRef = useRef<number | null>(null);
  const lastHoveredBlockStartRef = useRef<number | null>(null);
  /** Last known pointer position — shared with pointer-tracking closure for re-detection on doc changes. */
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen !== 'none';
  /** Keeps pointer-hover clearing in sync with block menu before `menuOpen` commits to `menuOpenRef`. */
  const blockTypeMenuOpenSyncRef = useRef(false);
  useLayoutEffect(() => {
    blockTypeMenuOpenSyncRef.current = menuOpen === 'handle';
  }, [menuOpen]);

  /** Insert slash palette replaces the handle menu — keep state in sync (no stuck “active” on drag). */
  useEffect(() => {
    if (!slashFromInsertOpen) return;
    blockTypeMenuOpenSyncRef.current = false;
    frozenHandleMenuBlockStartRef.current = null;
    setMenuOpen((m) => (m === 'handle' ? 'none' : m));
  }, [slashFromInsertOpen]);

  const menuHoverCloseTimerRef = useRef<number | null>(null);

  const clearMenuHoverCloseTimer = useCallback(() => {
    if (menuHoverCloseTimerRef.current != null) {
      window.clearTimeout(menuHoverCloseTimerRef.current);
      menuHoverCloseTimerRef.current = null;
    }
  }, []);

  const onHandlePointerEnter = useCallback(() => {
    clearMenuHoverCloseTimer();
  }, [clearMenuHoverCloseTimer]);

  const onHandlePointerLeave = useCallback(() => {
    if (menuOpenRef.current) return;
    clearMenuHoverCloseTimer();
    menuHoverCloseTimerRef.current = window.setTimeout(() => {
      menuHoverCloseTimerRef.current = null;
      setPosStable(null);
      displayedBlockStartRef.current = null;
    }, 120);
  }, [clearMenuHoverCloseTimer, setPosStable]);

  useEffect(() => () => clearMenuHoverCloseTimer(), [clearMenuHoverCloseTimer]);

  const updatePosition = useCallback(() => {
    const view = getEditorView(editor);
    if (!view) {
      setPosStable(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const blockStart = hoverBlockStartRef.current;
    if (blockStart == null) {
      setPosStable(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const editorDom = view.dom as HTMLElement;
    const hostEl = getBlockLinePortalHost(editor);

    const dom = resolveBlockDomForHandle(view, editorDom, blockStart);

    if (!dom) {
      setPosStable(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const rect = dom.getBoundingClientRect();
    const hitNode = getInnerBlockNodeAtStart(view.state.doc, blockStart);
    const isTableBlock = hitNode?.type.name === 'table';

    const cs = getComputedStyle(dom);
    const lh = cs.lineHeight;
    const lineHeight = lh === 'normal' ? (parseFloat(cs.fontSize) || 16) * 1.25 : parseFloat(lh) || 22;
    const firstRowRect = isTableBlock ? getTableFirstRowRect(dom) : null;
    const visualCenterY = firstRowRect ? firstRowRect.top + firstRowRect.height / 2 : rect.top + lineHeight / 2;

    const contentLeft = getEditorInnerContentRect(editorDom).left;

    const showFold = headingFoldArrowVisible(view, blockStart);
    const clusterW = gutterClusterWidthPx(showFold);
    const btnH = GUTTER_BTN_PX;

    if (!hostEl) {
      const left = contentLeft - clusterW - GUTTER_EDGE_GAP_PX;
      const top = visualCenterY - btnH / 2;
      displayedBlockStartRef.current = blockStart;
      setPosStable({ top, left, position: 'fixed' as const, blockStart });
      return;
    }

    const hostRect = hostEl.getBoundingClientRect();
    const left = contentLeft - hostRect.left - clusterW - GUTTER_EDGE_GAP_PX;
    const top = visualCenterY - hostRect.top - btnH / 2;

    displayedBlockStartRef.current = blockStart;
    setPosStable({ top, left: Math.max(8, left), position: 'absolute' as const, blockStart });
  }, [editor, setPosStable]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const runUpdate = () => {
      requestAnimationFrame(() => {
        // Re-detect block from the last known mouse position after each doc change.
        // Document edits shift ProseMirror positions, so hoverBlockStartRef may now
        // refer to a different block. Matches BlockNote SideMenu's `update()` PM hook
        // that calls `updateStateFromMousePos()` with stored mouse coordinates.
        if (hoverBlockStartRef.current != null) {
          const { x, y } = lastMousePosRef.current;
          if (x !== 0 || y !== 0) {
            const bs = getBlockStartFromMousePos(editor, x, y);
            if (bs != null) {
              hoverBlockStartRef.current = bs;
              lastHoveredBlockStartRef.current = bs;
            }
          }
        }
        updatePosition();
      });
    };
    const runSelection = () => {
      requestAnimationFrame(() => updatePosition());
    };
    editor.on('update', runUpdate);
    editor.on('transaction', runUpdate);
    editor.on('selectionUpdate', runSelection);
    return () => {
      editor.off('update', runUpdate);
      editor.off('transaction', runUpdate);
      editor.off('selectionUpdate', runSelection);
    };
  }, [editor, updatePosition]);

  useEffect(() => {
    return attachEditorWrapperScrollAndResize({
      editor,
      updatePosition,
      scrollIdleTimerRef,
      menuOpenRef,
      setIsScrollAnimSuppressed,
    });
  }, [editor, updatePosition]);

  useEffect(() => {
    const view = getEditorView(editor);
    if (!view) return;
    const editorDom = view.dom as HTMLElement;
    return attachGlobalPointerMoveForBlockHover({
      editor,
      editorDom,
      rootRef,
      hoverBlockStartRef,
      lastHoveredBlockStartRef,
      menuOpenRef,
      blockTypeMenuOpenSyncRef,
      updatePosition,
      lastMousePosRef,
    });
  }, [editor, updatePosition]);

  const handleMenuOutsideMouseDown = useCallback((e: MouseEvent) => {
    const t = e.target as Node;
    if (rootRef.current?.contains(t)) return;
    if (blockTypeMenuMainFloatRef.current?.contains(t)) return;
    if (blockTypeMenuSubFloatRef.current?.contains(t)) return;
    blockTypeMenuOpenSyncRef.current = false;
    setMenuOpen('none');
  }, []);

  const handleMenuEscapeKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      blockTypeMenuOpenSyncRef.current = false;
      setMenuOpen('none');
    }
  }, []);

  useEffect(() => {
    if (menuOpen === 'none') return;
    document.addEventListener('mousedown', handleMenuOutsideMouseDown);
    document.addEventListener('keydown', handleMenuEscapeKey);
    return () => {
      document.removeEventListener('mousedown', handleMenuOutsideMouseDown);
      document.removeEventListener('keydown', handleMenuEscapeKey);
    };
  }, [menuOpen, handleMenuOutsideMouseDown, handleMenuEscapeKey]);

  useEffect(() => {
    const view = getEditorView(editor);
    if (!view) return;
    const editorDom = view.dom as HTMLElement;
    editorDom.addEventListener('dragstart', preventEditorNativeDragStart);
    return () => editorDom.removeEventListener('dragstart', preventEditorNativeDragStart);
  }, [editor]);

  useEffect(() => {
    return attachDocumentBlockDragDrop({
      editor,
      dragPayloadRef,
      setDropIndicator,
      setDragging,
    });
  }, [editor]);

  const handleAddBlockMouseDown = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  const handleInsertBlockClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      const view = editor.view;
      const pm = breaticSlashMenuKey.getState(editor.state);
      if (pm && !pm.deleteTriggerCharacter) {
        closeBreaticSlashMenu(view);
        return;
      }
      if (pm && pm.deleteTriggerCharacter) {
        closeBreaticSlashMenu(view);
      }
      blockTypeMenuOpenSyncRef.current = false;
      setMenuOpen('none');
      const bs =
        pos?.blockStart ??
        displayedBlockStartRef.current ??
        hoverBlockStartRef.current ??
        lastHoveredBlockStartRef.current;
      if (bs == null) return;
      const { doc } = editor.state;

      if (isEmptyInsertLineBlock(doc, bs)) {
        editor.chain().focus().setTextSelection(bs + 1).scrollIntoView().run();
        openBreaticSlashMenu(editor, { deleteTriggerCharacter: false });
        return;
      }

      const end = getBlockEndPosRobust(editor, bs);
      if (end == null) return;
      editor
        .chain()
        .focus()
        .insertContentAt(end, { type: 'paragraph' })
        .setTextSelection(end + 1)
        .scrollIntoView()
        .run();
      openBreaticSlashMenu(editor, { deleteTriggerCharacter: false });
    },
    [editor, pos?.blockStart],
  );

  const handleDragHandleClick = useCallback(
    (e: ReactMouseEvent<HTMLSpanElement>) => {
      e.stopPropagation();
      setMenuOpen((m) => {
        if (m === 'handle') {
          blockTypeMenuOpenSyncRef.current = false;
          frozenHandleMenuBlockStartRef.current = null;
          return 'none';
        }
        const view = editor.view;
        if (breaticSlashMenuKey.getState(editor.state)) closeBreaticSlashMenu(view);
        const anchor =
          pos?.blockStart ??
          hoverBlockStartRef.current ??
          displayedBlockStartRef.current ??
          lastHoveredBlockStartRef.current;
        frozenHandleMenuBlockStartRef.current = anchor ?? null;
        if (anchor != null) {
          hoverBlockStartRef.current = anchor;
          lastHoveredBlockStartRef.current = anchor;
        }
        blockTypeMenuOpenSyncRef.current = true;
        return 'handle';
      });
    },
    [editor, pos?.blockStart],
  );

  const handleDragHandleMouseDown = useCallback(() => {
    clearMenuHoverCloseTimer();
  }, [clearMenuHoverCloseTimer]);

  const handleDragHandleDragStart = useCallback(
    (e: ReactDragEvent<HTMLSpanElement>) => {
      const bs = displayedBlockStartRef.current;
      if (bs == null) {
        e.preventDefault();
        return;
      }
      const ok = applyBlockDragStart(e, editor, bs, dragPayloadRef, () => {
        clearMenuHoverCloseTimer();
        setDragging(true);
        blockTypeMenuOpenSyncRef.current = false;
        setMenuOpen('none');
      });
      if (!ok) e.preventDefault();
    },
    [editor, clearMenuHoverCloseTimer],
  );

  const handleDragHandleDragEnd = useCallback(() => {
    dragPayloadRef.current = null;
    setDropIndicator(null);
    setDragging(false);
    editor.commands.focus();
  }, [editor]);

  const handleBlockTypeMenuClose = useCallback(() => {
    blockTypeMenuOpenSyncRef.current = false;
    frozenHandleMenuBlockStartRef.current = null;
    setMenuOpen('none');
  }, []);

  const handleFoldClick = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const v = getEditorView(editor);
      const bs = displayedBlockStartRef.current;
      if (!v || bs == null) return;
      toggleHeadingFold(v, bs);
    },
    [editor],
  );

  if (!pos) return null;

  const showFold = headingFoldArrowVisible(editor.view, pos.blockStart);
  const foldCollapsed = headingFoldPluginState?.collapsed.has(pos.blockStart) ?? false;

  let linePortalTarget: Element;
  if (pos.position === 'absolute') {
    const h = getBlockLinePortalHost(editor);
    if (!h) return null;
    linePortalTarget = h;
  } else {
    linePortalTarget = document.body;
  }

  const btnClass =
    'flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent cursor-pointer ' +
    'text-text-default-tertiary hover:bg-background-default-secondary hover:text-text-default-base ' +
    'transition-[background-color,color] duration-100';

  return (
    <>
      {dropIndicator != null &&
        (() => {
          const dropHost = dropIndicator.mode === 'absolute' ? getEditorPortalHost(editor) : document.body;
          if (dropIndicator.mode === 'absolute' && !dropHost) return null;
          return createPortal(
            <div
              className={cn(
                'pointer-events-none z-[59] h-0.5 rounded-full',
                dropIndicator.mode === 'fixed' ? 'fixed' : 'absolute',
              )}
              style={{
                top: dropIndicator.top - 1,
                left: dropIndicator.left,
                width: dropIndicator.width,
                backgroundColor: 'var(--color-brand-base, #3563E9)',
                boxShadow: '0 0 0 1px var(--color-brand-base, #3563E9)',
              }}
              aria-hidden
            />,
            dropHost!,
          );
        })()}

      {createPortal(
        <div
          ref={rootRef}
          className={cn(
            'flex select-none items-center gap-0',
            !dragging &&
              !isScrollAnimSuppressed &&
              'transition-[top,left] duration-150 ease-out motion-reduce:transition-none',
          )}
          style={{
            position: pos.position,
            pointerEvents: 'auto',
            left: Math.max(8, pos.left),
            top: pos.top,
            zIndex: BLOCK_LINE_CONTROL_Z,
          }}
          onPointerEnter={onHandlePointerEnter}
          onPointerLeave={onHandlePointerLeave}
        >
          <div className='relative'>
            <Tooltip title='Insert block' placement='top' offset={4} disabled={menuOpen === 'handle'}>
              <button
                type='button'
                className={cn(
                  btnClass,
                  slashFromInsertOpen && 'bg-background-default-secondary text-text-default-base',
                )}
                onMouseDown={handleAddBlockMouseDown}
                onClick={handleInsertBlockClick}
                aria-label='Insert block'
                aria-expanded={slashFromInsertOpen}
                aria-haspopup='listbox'
              >
                <RiAddLine size={15} />
              </button>
            </Tooltip>
          </div>

          <div className='relative'>
            <Tooltip
              title='Drag to move · Click for options'
              placement='top'
              offset={4}
              disabled={dragging || slashFromInsertOpen}
            >
              <span
                ref={dragHandleRef}
                draggable
                role='button'
                tabIndex={-1}
                className={cn(
                  btnClass,
                  'cursor-grab active:cursor-grabbing',
                  menuOpen === 'handle' && 'bg-background-default-secondary text-text-default-base',
                )}
                aria-label='Drag to move block or click for block options'
                aria-expanded={menuOpen === 'handle'}
                aria-haspopup='menu'
                onClick={handleDragHandleClick}
                onMouseDown={handleDragHandleMouseDown}
                onDragStart={handleDragHandleDragStart}
                onDragEnd={handleDragHandleDragEnd}
              >
                <MdDragIndicator size={16} />
              </span>
            </Tooltip>

            {menuOpen === 'handle' && !slashFromInsertOpen && (
              <BlockTypeMenu
                editor={editor}
                anchorBlockStartRef={frozenHandleMenuBlockStartRef}
                onClose={handleBlockTypeMenuClose}
                anchorElRef={dragHandleRef}
                mainFloatingRef={blockTypeMenuMainFloatRef}
                subFloatingRef={blockTypeMenuSubFloatRef}
              />
            )}
          </div>

          {showFold && (
            <div className='relative'>
              <Tooltip title={foldCollapsed ? 'Expand' : 'Collapse'} placement='top' offset={4}>
                <button
                  type='button'
                  className={cn(
                    btnClass,
                    'opacity-0 [.breatic-editor-wrapper:hover_&]:opacity-40',
                    'hover:!opacity-100',
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleFoldClick}
                  aria-label={foldCollapsed ? 'Expand section' : 'Collapse section'}
                >
                  <RiArrowRightSFill
                    size={20}
                    className='transition-transform duration-150 ease-out'
                    style={{ transform: foldCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
                  />
                </button>
              </Tooltip>
            </div>
          )}
        </div>,
        linePortalTarget,
      )}
    </>
  );
};

export default BlockLineControl;
