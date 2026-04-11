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
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { MdDragIndicator } from 'react-icons/md';
import { RiAddLine } from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import Tooltip from '@/components/base/tooltip';
import BlockTypeMenu from '@/apps/project/components/textEditor/components/BlockTypeMenu';

interface BlockLineControlProps {
  editor: Editor;
}

/* ─── ProseMirror helpers ─────────────────────────────────────────── */

/** Innermost line-level block for a resolved position. */
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
      name === 'horizontalRule'
    ) {
      return $pos.before(d);
    }
  }
  if ($pos.depth >= 1) return $pos.before(1);
  return null;
};

const getBlockStartAtDocPos = (editor: Editor, pos: number): number | null => {
  const doc = editor.state.doc;
  const safe = Math.max(0, Math.min(pos, doc.content.size));
  return getBlockStartPosFromResolved(doc.resolve(safe));
};

const getBlockEndPos = (editor: Editor, blockStart: number): number | null => {
  const doc = editor.state.doc;
  const $pos = doc.resolve(blockStart + 1);
  for (let d = $pos.depth; d >= 1; d -= 1) {
    if ($pos.before(d) === blockStart) return $pos.after(d);
  }
  return null;
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
  updatePosition: () => void;
};

const attachGlobalPointerMoveForBlockHover = (args: PointerTrackingArgs): (() => void) => {
  const { editor, editorDom, rootRef, hoverBlockStartRef, lastHoveredBlockStartRef, menuOpenRef, updatePosition } =
    args;

  let raf = 0;
  let pendingEvent: PointerEvent | null = null;
  let clearHoverTimer: number | null = null;
  const lastPointer = { x: 0, y: 0 };

  const cancelClearHover = () => {
    if (clearHoverTimer != null) {
      window.clearTimeout(clearHoverTimer);
      clearHoverTimer = null;
    }
  };

  const scheduleClearHover = () => {
    if (clearHoverTimer != null) return;
    clearHoverTimer = window.setTimeout(() => {
      clearHoverTimer = null;
      const t = document.elementFromPoint(lastPointer.x, lastPointer.y);
      const root = rootRef.current;
      const v = getEditorView(editor);
      const ed = v?.dom as HTMLElement;
      const stillInside = t && ((ed && ed.contains(t)) || (root && root.contains(t)));
      if (stillInside) return;
      hoverBlockStartRef.current = null;
      lastHoveredBlockStartRef.current = null;
      if (!menuOpenRef.current) updatePosition();
    }, 100);
  };

  const runFromEvent = (e: PointerEvent) => {
    if (menuOpenRef.current) return;

    const v = getEditorView(editor);
    if (!v) return;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;

    const topEl = document.elementFromPoint(e.clientX, e.clientY);
    const root = rootRef.current;
    const overEditor = Boolean(topEl && editorDom.contains(topEl));
    const overHandle = Boolean(topEl && root?.contains(topEl));

    if (overHandle) {
      cancelClearHover();
      if (hoverBlockStartRef.current == null && lastHoveredBlockStartRef.current != null) {
        hoverBlockStartRef.current = lastHoveredBlockStartRef.current;
      }
      updatePosition();
      return;
    }

    if (!overEditor) {
      scheduleClearHover();
      return;
    }

    cancelClearHover();

    const edRect = editorDom.getBoundingClientRect();
    const clampedX = Math.min(Math.max(edRect.left + 10, e.clientX), edRect.right - 10);
    const coords = v.posAtCoords({ left: clampedX, top: e.clientY });
    if (!coords) {
      updatePosition();
      return;
    }

    const bs = getBlockStartAtDocPos(editor, coords.pos);
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

type DragDropAttachArgs = {
  editor: Editor;
  dragPayloadRef: RefObject<{ from: number; to: number } | null>;
  setDropIndicator: React.Dispatch<
    React.SetStateAction<{ top: number; left: number; width: number } | null>
  >;
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

  const clampX = (clientX: number) => {
    const edRect = dom.getBoundingClientRect();
    return Math.min(Math.max(edRect.left + 10, clientX), edRect.right - 10);
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

    const coords = pmView.posAtCoords({ left: clampX(e.clientX), top: e.clientY });
    if (!coords) {
      setDropIndicator(null);
      return;
    }

    const innerStart = getBlockStartAtDocPos(editor, coords.pos);
    if (innerStart == null) {
      setDropIndicator(null);
      return;
    }

    const tgt = getTopLevelBlockRange(editor.state.doc, innerStart);
    if (!tgt) {
      setDropIndicator(null);
      return;
    }

    const nodeDom = pmView.nodeDOM(tgt.start) as HTMLElement | null;
    if (!nodeDom || !edRect.width) {
      setDropIndicator(null);
      return;
    }

    const r = nodeDom.getBoundingClientRect();
    const placeAfter = e.clientY >= r.top + r.height / 2;
    const pad = 12;
    setDropIndicator({
      top: placeAfter ? r.bottom : r.top,
      left: edRect.left + pad,
      width: Math.max(0, edRect.width - pad * 2),
    });
  };

  const onDrop = (e: DragEvent) => {
    const payload = dragPayloadRef.current;
    if (!payload) return;
    e.preventDefault();

    const coords = pmView.posAtCoords({ left: clampX(e.clientX), top: e.clientY });
    if (!coords) {
      clearDragUi();
      return;
    }

    const innerStart = getBlockStartAtDocPos(editor, coords.pos);
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

    const nodeDom = pmView.nodeDOM(tgt.start) as HTMLElement | null;
    let placeAfter = false;
    if (nodeDom) {
      const r = nodeDom.getBoundingClientRect();
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

/* ─── Component ───────────────────────────────────────────────────── */

/**
 * BlockNote-style side handle:
 * - Shows **only on hover** (not on caret/focus, matching BlockNote behaviour).
 * - [+] button inserts a new paragraph below.
 * - [⠿] drag handle: drag to reorder, click to open block options menu.
 * - Menu is **frozen** (stops tracking mouse) while context menu is open.
 */
const BlockLineControl = ({ editor }: BlockLineControlProps) => {
  const tx = useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [isScrollAnimSuppressed, setIsScrollAnimSuppressed] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const dragPayloadRef = useRef<{ from: number; to: number } | null>(null);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const displayedBlockStartRef = useRef<number | null>(null);
  const hoverBlockStartRef = useRef<number | null>(null);
  const lastHoveredBlockStartRef = useRef<number | null>(null);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
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
      setPos(null);
      displayedBlockStartRef.current = null;
    }, 120);
  }, [clearMenuHoverCloseTimer]);

  useEffect(() => () => clearMenuHoverCloseTimer(), [clearMenuHoverCloseTimer]);

  const updatePosition = useCallback(() => {
    if (menuOpenRef.current) return;

    const view = getEditorView(editor);
    if (!view) {
      setPos(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const blockStart = hoverBlockStartRef.current;
    if (blockStart == null) {
      setPos(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const editorDom = view.dom as HTMLElement;
    let dom = view.nodeDOM(blockStart) as HTMLElement | null;

    if (!dom || !editorDom.contains(dom)) {
      const domAt = view.domAtPos(blockStart + 1);
      let el = domAt.node as HTMLElement;
      if (el.nodeType === Node.TEXT_NODE) el = el.parentElement as HTMLElement;
      while (el && el.parentElement !== editorDom) {
        el = el.parentElement as HTMLElement;
      }
      dom = el && el !== editorDom ? el : null;
    }

    if (!dom || dom === editorDom) {
      setPos(null);
      displayedBlockStartRef.current = null;
      return;
    }

    const rect = dom.getBoundingClientRect();
    const cs = getComputedStyle(dom);
    const lh = cs.lineHeight;
    const lineHeight = lh === 'normal' ? (parseFloat(cs.fontSize) || 16) * 1.25 : parseFloat(lh) || 22;

    const editorFirstChild = editorDom.firstChild as HTMLElement | null;
    const contentLeft = editorFirstChild
      ? editorFirstChild.getBoundingClientRect().left
      : editorDom.getBoundingClientRect().left;

    const handleWidth = 52;
    const handleGap = 8;
    const left = contentLeft - handleWidth - handleGap;

    const btnH = 24;
    const top = rect.top + lineHeight / 2 - btnH / 2;

    displayedBlockStartRef.current = blockStart;
    setPos({ top, left });
  }, [editor]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition, tx]);

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
      updatePosition,
    });
  }, [editor, updatePosition]);

  const handleMenuOutsideMouseDown = useCallback((e: MouseEvent) => {
    if (rootRef.current?.contains(e.target as Node)) return;
    setMenuOpen(false);
  }, []);

  const handleMenuEscapeKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setMenuOpen(false);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
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

  const insertBelow = useCallback(() => {
    const bs = displayedBlockStartRef.current;
    if (bs == null) return;
    const end = getBlockEndPos(editor, bs);
    if (end == null) return;
    editor.chain().focus().insertContentAt(end, { type: 'paragraph' }).run();
  }, [editor]);

  const handleAddBlockMouseDown = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  const handleDragHandleClick = useCallback((e: ReactMouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setMenuOpen((v) => !v);
  }, []);

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
        setMenuOpen(false);
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
    setMenuOpen(false);
  }, []);

  if (!pos) return null;

  const btnClass =
    'flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent cursor-pointer ' +
    'text-text-default-tertiary hover:bg-background-default-secondary hover:text-text-default-base ' +
    'transition-[background-color,color] duration-100';

  return (
    <>
      {dropIndicator != null &&
        createPortal(
          <div
            className='pointer-events-none fixed z-[9995] h-0.5 rounded-full'
            style={{
              top: dropIndicator.top - 1,
              left: dropIndicator.left,
              width: dropIndicator.width,
              backgroundColor: 'var(--color-brand-base, #3563E9)',
              boxShadow: '0 0 0 1px var(--color-brand-base, #3563E9)',
            }}
            aria-hidden
          />,
          document.body,
        )}

      {createPortal(
        <div
          ref={rootRef}
          className={cn(
            'flex select-none items-center gap-0.5',
            !dragging &&
              !isScrollAnimSuppressed &&
              'transition-[top,left] duration-150 ease-out motion-reduce:transition-none',
          )}
          style={{
            position: 'fixed',
            pointerEvents: 'auto',
            left: Math.max(8, pos.left),
            top: pos.top,
            zIndex: 9996,
          }}
          onPointerEnter={onHandlePointerEnter}
          onPointerLeave={onHandlePointerLeave}
        >
          <Tooltip title='Add block below' placement='top' offset={4}>
            <button
              type='button'
              className={btnClass}
              onMouseDown={handleAddBlockMouseDown}
              onClick={insertBelow}
              aria-label='Add block below'
            >
              <RiAddLine size={15} />
            </button>
          </Tooltip>

          <div className='relative'>
            <Tooltip title='Drag to move · Click for options' placement='top' offset={4}>
              <span
                draggable
                role='button'
                tabIndex={-1}
                className={cn(
                  btnClass,
                  'cursor-grab active:cursor-grabbing',
                  menuOpen && 'bg-background-default-secondary text-text-default-base',
                )}
                aria-label='Drag to move block or click for block options'
                aria-expanded={menuOpen}
                aria-haspopup='menu'
                onClick={handleDragHandleClick}
                onMouseDown={handleDragHandleMouseDown}
                onDragStart={handleDragHandleDragStart}
                onDragEnd={handleDragHandleDragEnd}
              >
                <MdDragIndicator size={16} />
              </span>
            </Tooltip>

            {menuOpen && (
              <BlockTypeMenu
                editor={editor}
                anchorBlockStartRef={displayedBlockStartRef}
                onClose={handleBlockTypeMenuClose}
              />
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default BlockLineControl;
