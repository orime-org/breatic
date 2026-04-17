import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from '@floating-ui/react';
import { useEditorState, type Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import {
  isMediaLikeBlockType,
  mediaBlockSupportsTextAlign,
} from '@/apps/project/components/textEditor/shared/MediaBlockTypes';
import {
  RiDeleteBin6Line,
  RiSparkling2Fill,
  RiSparkling2Line,
  RiExpandUpDownLine,
  RiContractUpDownLine,
  RiTranslateAi,
  RiExchangeLine,
  RiPlayListAddLine,
  RiAlignLeft,
  RiAlignCenter,
  RiAlignRight,
  RiAlignTop,
  RiAlignVertically,
  RiAlignBottom,
  RiIndentIncrease,
  RiIndentDecrease,
  RiArrowRightSLine,
  RiText,
  RiH1,
  RiH2,
  RiH3,
  RiListUnordered,
  RiListOrdered,
  RiCodeBoxLine,
  RiDoubleQuotesL,
  RiPaletteLine,
  RiCheckLine,
} from 'react-icons/ri';
import { cn } from '@/utils/classnames';
import { TextColorPalettePanel } from '@/apps/project/components/textEditor/formatting/TextColorSelect';
import { BlockHighlightIcon, BlockIndentAlignIcon, BlockTaskListIcon } from '../ui/TextEditorIcons';
import {
  decreaseBlockIndent,
  increaseBlockIndent,
} from '@/apps/project/components/textEditor/extensions/BlockIndentExtension';
import {
  selectWholeTable,
  setWholeTableVerticalAlign,
} from '@/apps/project/components/textEditor/table/tableSelectionHelpers';
import { getTextEditorBridgeStorage } from '@/apps/project/components/textEditor/extensions/TextEditorBridgeExtension';

/** Same horizontal alignment as row/column handle menus (`cell.attrs.align`). */
function setTableAllCellsAlign(editor: Editor, tableStart: number, align: 'left' | 'center' | 'right'): boolean {
  const table = editor.state.doc.nodeAt(tableStart);
  if (!table || table.type.name !== 'table') return false;
  const map = TableMap.get(table);
  const tableContentStart = tableStart + 1;
  const { state, view } = editor;
  let tr = state.tr;
  for (let row = 0; row < map.height; row += 1) {
    for (let col = 0; col < map.width; col += 1) {
      const abs = tableContentStart + map.map[row * map.width + col];
      const cell = tr.doc.nodeAt(abs);
      if (!cell || (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader')) continue;
      tr = tr.setNodeMarkup(abs, undefined, { ...cell.attrs, align });
    }
  }
  if (!tr.docChanged) return false;
  view.dispatch(tr);
  return true;
}

const getTopLevelBlockRange = (doc: PMNode, innerBlockStart: number): { start: number; end: number } | null => {
  const safe = Math.min(Math.max(innerBlockStart + 1, 1), doc.content.size);
  const $pos = doc.resolve(safe);
  if ($pos.depth < 1) return null;
  return { start: $pos.before(1), end: $pos.after(1) };
};

/**
 * Resolve the active block-type key directly from the ProseMirror document,
 * without requiring the editor selection to be at `bs`. Walks from depth 1
 * (outermost) inward so list containers (bulletList / orderedList / taskList)
 * take precedence over the inner paragraph they contain.
 */
const resolveAnchorActiveKey = (doc: PMNode, bs: number | null): string | null => {
  if (bs == null) return null;
  const safePos = Math.min(bs + 1, doc.content.size);
  if (safePos < 1) return null;
  const $pos = doc.resolve(safePos);
  for (let d = 1; d <= $pos.depth; d++) {
    const node = $pos.node(d);
    const name = node.type.name;
    if (name === 'bulletList') return 'bulletList';
    if (name === 'orderedList') return 'orderedList';
    if (name === 'taskList') return 'taskList';
    if (name === 'blockquote') return 'blockquote';
    if (name === 'codeBlock') return 'codeBlock';
    if (name === 'horizontalRule') return 'horizontalRule';
    if (name === 'heading') return `h${node.attrs.level as number}`;
    if (name === 'highlightBlock') return 'highlight';
    if (name === 'paragraph') return 'paragraph';
  }
  return null;
};

const itemClass =
  'flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary';

const labelClass =
  'px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-default-tertiary select-none';

const blockTypeMenuSurfaceClass =
  'min-w-[208px] overflow-visible rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)]';

const blockTypeAlignSubmenuSurfaceClass =
  'min-w-[192px] rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)]';

/** Above block-line controls, below top text bubbles. */
const BLOCK_TYPE_MENU_Z = 70;
const BLOCK_TYPE_SUBMENU_Z = 71;

/** Block handle menu: only “Delete block” (no turn-into / align / color). */
const BLOCK_TYPES_DELETE_ONLY_MENU = new Set<string>([
  'codeBlock',
  'horizontalRule',
  'audio',
  'pendingAudio',
  'pendingFile',
]);

type BlockTypeFloatRef = RefObject<HTMLDivElement | null>;

function BlockTypeMenuMainFloat({
  open,
  anchorEl,
  children,
  className,
  zIndex,
  floatingRef,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  children: ReactNode;
  className: string;
  zIndex: number;
  floatingRef: BlockTypeFloatRef;
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

function BlockTypeMenuSubFloat({
  open,
  anchorEl,
  children,
  className,
  zIndex,
  floatingRef,
}: {
  open: boolean;
  anchorEl: HTMLElement | null;
  children: ReactNode;
  className: string;
  zIndex: number;
  floatingRef: BlockTypeFloatRef;
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

export interface BlockTypeMenuProps {
  editor: Editor;
  anchorBlockStartRef: RefObject<number | null>;
  onClose: () => void;
  /** Drag-handle element this menu is anchored to (floating-ui reference). */
  anchorElRef: RefObject<HTMLElement | null>;
  /** Portaled main panel root — include in outside-click checks in the parent. */
  mainFloatingRef: BlockTypeFloatRef;
  /** Portaled submenu root (only one submenu open at a time). */
  subFloatingRef: BlockTypeFloatRef;
}

type Chain = ReturnType<Editor['chain']>;

type BlockMenuIcon = ComponentType<{ size?: number; className?: string }>;

const BASIC_BLOCKS: readonly {
  label: string;
  Icon: BlockMenuIcon;
  nodeKey: string;
  apply: (ch: Chain) => void;
}[] = [
  { label: 'Paragraph', Icon: RiText, nodeKey: 'paragraph', apply: (ch) => ch.setParagraph().run() },
  { label: 'Heading 1', Icon: RiH1, nodeKey: 'h1', apply: (ch) => ch.setHeading({ level: 1 }).run() },
  { label: 'Heading 2', Icon: RiH2, nodeKey: 'h2', apply: (ch) => ch.setHeading({ level: 2 }).run() },
  { label: 'Heading 3', Icon: RiH3, nodeKey: 'h3', apply: (ch) => ch.setHeading({ level: 3 }).run() },
  { label: 'Bullet list', Icon: RiListUnordered, nodeKey: 'bulletList', apply: (ch) => ch.toggleBulletList().run() },
  { label: 'Numbered list', Icon: RiListOrdered, nodeKey: 'orderedList', apply: (ch) => ch.toggleOrderedList().run() },
  { label: 'Task list', Icon: BlockTaskListIcon, nodeKey: 'taskList', apply: (ch) => ch.toggleTaskList().run() },
  { label: 'Code block', Icon: RiCodeBoxLine, nodeKey: 'codeBlock', apply: (ch) => ch.toggleCodeBlock().run() },
  { label: 'Quote', Icon: RiDoubleQuotesL, nodeKey: 'blockquote', apply: (ch) => ch.toggleBlockquote().run() },
  {
    label: 'Highlight block',
    Icon: BlockHighlightIcon,
    nodeKey: 'highlight',
    apply: (ch) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ch as any).toggleHighlightBlock().run(),
  },
] as const;
type HandleSubmenu = 'none' | 'alignIndent' | 'color' | 'askAI';

/** Improve 子菜单行：与「Indent & align」里 Align / Indent 行一致（15px 图标 + tertiary）。 */
const submenuRowIconClass = 'shrink-0 text-text-default-tertiary';

const ASK_AI_ACTIONS: readonly {
  key: string;
  label: string;
  Icon: BlockMenuIcon;
  replacement: string;
}[] = [
  { key: 'polish', label: 'Polish', Icon: RiSparkling2Line, replacement: '[POLISH] This is fixed replacement content.' },
  { key: 'expand', label: 'Expand', Icon: RiExpandUpDownLine, replacement: '[EXPAND] This is fixed replacement content.' },
  { key: 'summarize', label: 'Summarize', Icon: RiContractUpDownLine, replacement: '[SUMMARIZE] This is fixed replacement content.' },
  { key: 'translate', label: 'Translate', Icon: RiTranslateAi, replacement: '[TRANSLATE] This is fixed replacement content.' },
  { key: 'rewrite', label: 'Rewrite', Icon: RiExchangeLine, replacement: '[REWRITE] This is fixed replacement content.' },
  { key: 'continue', label: 'Continue', Icon: RiPlayListAddLine, replacement: '[CONTINUE] This is fixed replacement content.' },
] as const;

const BlockTypeMenu = ({
  editor,
  anchorBlockStartRef,
  onClose,
  anchorElRef,
  mainFloatingRef,
  subFloatingRef,
}: BlockTypeMenuProps) => {
  const [handleSubmenu, setHandleSubmenu] = useState<HandleSubmenu>('none');
  const alignIndentBtnRef = useRef<HTMLButtonElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const askAIBtnRef = useRef<HTMLButtonElement>(null);
  const activeNodeKey = resolveAnchorActiveKey(editor.state.doc, anchorBlockStartRef.current);
  /** Doc node at frozen anchor — reliable for horizontalRule (resolveAnchorActiveKey can miss thin blocks). */
  const anchoredBlockType = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const bs = anchorBlockStartRef.current;
      if (bs == null) return null;
      return ed.state.doc.nodeAt(bs)?.type.name ?? null;
    },
  });

  const focusAnchorBlock = useCallback(() => {
    const bs = anchorBlockStartRef.current;
    if (bs == null) return;
    const n = editor.state.doc.nodeAt(bs);
    if (n && isMediaLikeBlockType(n.type.name)) {
      editor.chain().focus().setNodeSelection(bs).run();
      return;
    }
    if (n?.type.name === 'table') {
      selectWholeTable(editor, bs);
      return;
    }
    editor.chain().focus().setTextSelection(bs + 1).run();
  }, [anchorBlockStartRef, editor]);

  const runTransform = useCallback(
    (fn: (ch: Chain) => void) => {
      focusAnchorBlock();
      fn(editor.chain().focus());
      onClose();
    },
    [editor, focusAnchorBlock, onClose],
  );

  const deleteBlock = () => {
    const bs = anchorBlockStartRef.current;
    if (bs == null) {
      onClose();
      return;
    }
    const { state, view } = editor;
    const node = state.doc.nodeAt(bs);
    if (!node) {
      onClose();
      return;
    }
    const end = bs + node.nodeSize;
    if (end <= bs) {
      onClose();
      return;
    }
    view.dispatch(state.tr.delete(bs, end));
    editor.commands.focus();
    onClose();
  };

  const editWithAI = useCallback((initialReplacement: string | null = null) => {
    const bs = anchorBlockStartRef.current;
    if (bs == null) {
      onClose();
      return;
    }
    const node = editor.state.doc.nodeAt(bs);
    if (!node) {
      onClose();
      return;
    }
    const from = bs + 1;
    const to = bs + node.nodeSize - 1;
    if (to <= from) {
      onClose();
      return;
    }
    getTextEditorBridgeStorage(editor).openSelectionAIMenu?.({
      initialReplacement,
      range: { from, to },
    });
    onClose();
  }, [anchorBlockStartRef, editor, onClose]);

  const setAlign = (align: 'left' | 'center' | 'right') => {
    const bs = anchorBlockStartRef.current;
    if (bs == null) {
      onClose();
      return;
    }
    const node = editor.state.doc.nodeAt(bs);
    if (node?.type.name === 'table') {
      setTableAllCellsAlign(editor, bs, align);
      selectWholeTable(editor, bs);
      onClose();
      return;
    }
    if (node && mediaBlockSupportsTextAlign(node.type.name)) {
      editor.chain().focus().setNodeSelection(bs).updateAttributes(node.type.name, { textAlign: align }).run();
      onClose();
      return;
    }
    runTransform((ch) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ch as any).setTextAlign(align).run(),
    );
  };

  const setTableVerticalAlign = useCallback(
    (verticalAlign: 'top' | 'middle' | 'bottom') => {
      const bs = anchorBlockStartRef.current;
      if (bs == null) {
        onClose();
        return;
      }
      const table = editor.state.doc.nodeAt(bs);
      if (!table || table.type.name !== 'table') {
        onClose();
        return;
      }
      setWholeTableVerticalAlign(editor, bs, verticalAlign);
      selectWholeTable(editor, bs);
      onClose();
    },
    [editor, anchorBlockStartRef, onClose],
  );

  const sinkOrLift = (dir: 'sink' | 'lift') => {
    focusAnchorBlock();
    if (dir === 'sink') increaseBlockIndent(editor);
    else decreaseBlockIndent(editor);
    onClose();
  };

  const toggleAlignIndentSubmenu = () => {
    focusAnchorBlock();
    setHandleSubmenu((s) => (s === 'alignIndent' ? 'none' : 'alignIndent'));
  };

  const toggleColorSubmenu = () => {
    focusAnchorBlock();
    setHandleSubmenu((s) => (s === 'color' ? 'none' : 'color'));
  };
  const toggleAskAISubmenu = () => {
    focusAnchorBlock();
    setHandleSubmenu((s) => (s === 'askAI' ? 'none' : 'askAI'));
  };

  const anchorBs = anchorBlockStartRef.current;
  const anchorNode = anchorBs != null ? editor.state.doc.nodeAt(anchorBs) : null;
  const mediaMenu = Boolean(anchorNode && isMediaLikeBlockType(anchorNode.type.name));
  const deleteOnlyMenu =
    anchoredBlockType != null && BLOCK_TYPES_DELETE_ONLY_MENU.has(anchoredBlockType);
  /** Table: horizontal + vertical align, Color, Delete (no Turn into / no indent). */
  const tableAnchorMenu = anchoredBlockType === 'table';
  const showAskAI =
    Boolean(anchorNode) &&
    !mediaMenu &&
    !tableAnchorMenu &&
    !deleteOnlyMenu &&
    (Boolean(anchorNode?.isTextblock) ||
      anchorNode?.type.name === 'bulletList' ||
      anchorNode?.type.name === 'orderedList' ||
      anchorNode?.type.name === 'taskList');

  const blockRows = !mediaMenu && !tableAnchorMenu ? (
    <>
      <p className={labelClass}>Turn into</p>
      {BASIC_BLOCKS.map(({ label, Icon, nodeKey, apply }) => {
        const isActive = activeNodeKey === nodeKey;
        return (
          <button
            key={label}
            type='button'
            role='menuitem'
            className={cn(itemClass, isActive && 'bg-background-default-secondary font-medium')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTransform(apply)}
          >
            <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
              <Icon size={16} />
            </span>
            {label}
            {isActive && <RiCheckLine size={14} className='ml-auto shrink-0 text-text-default-base' />}
          </button>
        );
      })}
    </>
  ) : null;

  return (
    <BlockTypeMenuMainFloat
      open
      anchorEl={anchorElRef.current}
      className={blockTypeMenuSurfaceClass}
      zIndex={BLOCK_TYPE_MENU_Z}
      floatingRef={mainFloatingRef}
    >
      {!deleteOnlyMenu && (
        <>
          {blockRows}
          {blockRows && <div className='my-1.5 border-t border-border-default-base' />}

          <button
            ref={alignIndentBtnRef}
            type='button'
            role='menuitem'
            aria-expanded={handleSubmenu === 'alignIndent'}
            aria-haspopup='menu'
            className={cn(itemClass, handleSubmenu === 'alignIndent' && 'bg-background-default-secondary')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleAlignIndentSubmenu}
          >
            <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
              <BlockIndentAlignIcon size={16} />
            </span>
            {tableAnchorMenu ? 'Align' : 'Indent & align'}
            <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
          </button>
          <BlockTypeMenuSubFloat
            open={handleSubmenu === 'alignIndent'}
            anchorEl={alignIndentBtnRef.current}
            className={blockTypeAlignSubmenuSurfaceClass}
            zIndex={BLOCK_TYPE_SUBMENU_Z}
            floatingRef={subFloatingRef}
          >
            <>
              <p className={labelClass}>Align</p>
              <button type='button' role='menuitem' className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign('left')}>
                <RiAlignLeft size={15} className='shrink-0 text-text-default-tertiary' />
                Align left
              </button>
              <button type='button' role='menuitem' className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign('center')}>
                <RiAlignCenter size={15} className='shrink-0 text-text-default-tertiary' />
                Align center
              </button>
              <button type='button' role='menuitem' className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => setAlign('right')}>
                <RiAlignRight size={15} className='shrink-0 text-text-default-tertiary' />
                Align right
              </button>
              {tableAnchorMenu && (
                <>
                  <div className='my-1.5 border-t border-border-default-base' />
                  <p className={labelClass}>Vertical align</p>
                  <button
                    type='button'
                    role='menuitem'
                    className={itemClass}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setTableVerticalAlign('top')}
                  >
                    <RiAlignTop size={15} className='shrink-0 text-text-default-tertiary' />
                    Align top
                  </button>
                  <button
                    type='button'
                    role='menuitem'
                    className={itemClass}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setTableVerticalAlign('middle')}
                  >
                    <RiAlignVertically size={15} className='shrink-0 text-text-default-tertiary' />
                    Align middle
                  </button>
                  <button
                    type='button'
                    role='menuitem'
                    className={itemClass}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setTableVerticalAlign('bottom')}
                  >
                    <RiAlignBottom size={15} className='shrink-0 text-text-default-tertiary' />
                    Align bottom
                  </button>
                </>
              )}
              {!tableAnchorMenu && (
                <>
                  <p className={labelClass}>Indent</p>
                  <button type='button' role='menuitem' className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => sinkOrLift('sink')}>
                    <RiIndentIncrease size={15} className='shrink-0 text-text-default-tertiary' />
                    Increase indent
                  </button>
                  <button type='button' role='menuitem' className={itemClass} onMouseDown={(e) => e.preventDefault()} onClick={() => sinkOrLift('lift')}>
                    <RiIndentDecrease size={15} className='shrink-0 text-text-default-tertiary' />
                    Decrease indent
                  </button>
                </>
              )}
            </>
          </BlockTypeMenuSubFloat>

          <button
            ref={colorBtnRef}
            type='button'
            role='menuitem'
            aria-expanded={handleSubmenu === 'color'}
            aria-haspopup='menu'
            className={cn(itemClass, handleSubmenu === 'color' && 'bg-background-default-secondary')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleColorSubmenu}
          >
            <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
              <RiPaletteLine size={16} />
            </span>
            Color
            <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
          </button>
          <BlockTypeMenuSubFloat
            open={handleSubmenu === 'color'}
            anchorEl={colorBtnRef.current}
            className='outline-none'
            zIndex={BLOCK_TYPE_SUBMENU_Z}
            floatingRef={subFloatingRef}
          >
            <TextColorPalettePanel
              editor={editor}
              atomBlockPos={mediaMenu && anchorBs != null ? anchorBs : undefined}
              tableScope={
                tableAnchorMenu && anchorBs != null ? { axis: 'whole', tableStart: anchorBs } : undefined
              }
              blockScope={(() => {
                if (mediaMenu || tableAnchorMenu) return undefined;
                const bs = anchorBlockStartRef.current;
                if (bs == null) return undefined;
                const range = getTopLevelBlockRange(editor.state.doc, bs);
                if (!range) return undefined;
                return { from: range.start + 1, to: range.end - 1 };
              })()}
              onAfterPick={() => {
                setHandleSubmenu('none');
                onClose();
              }}
            />
          </BlockTypeMenuSubFloat>
          {showAskAI && <div className='my-1.5 border-t border-border-default-base' />}

          {showAskAI && (
            <>
              <button
                ref={askAIBtnRef}
                type='button'
                role='menuitem'
                aria-expanded={handleSubmenu === 'askAI'}
                aria-haspopup='menu'
                className={cn(itemClass, handleSubmenu === 'askAI' && 'bg-background-default-secondary')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={toggleAskAISubmenu}
              >
                <span className='inline-flex h-6 w-6 shrink-0 items-center justify-center text-icon-base'>
                  <RiSparkling2Fill size={16} />
                </span>
                Improve
                <RiArrowRightSLine size={16} className='ml-auto shrink-0 text-text-default-tertiary' />
              </button>
              <BlockTypeMenuSubFloat
                open={handleSubmenu === 'askAI'}
                anchorEl={askAIBtnRef.current}
                className={blockTypeAlignSubmenuSurfaceClass}
                zIndex={BLOCK_TYPE_SUBMENU_Z}
                floatingRef={subFloatingRef}
              >
                <>
                  <p className={labelClass}>Improve</p>
                  {ASK_AI_ACTIONS.map(({ key, label, Icon, replacement }) => (
                    <button
                      key={key}
                      type='button'
                      role='menuitem'
                      className={itemClass}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => editWithAI(replacement)}
                    >
                      <Icon size={15} className={submenuRowIconClass} />
                      {label}
                    </button>
                  ))}
                </>
              </BlockTypeMenuSubFloat>
            </>
          )}
          <div className='my-1.5 border-t border-border-default-base' />
        </>
      )}

      <button
        type='button'
        role='menuitem'
        className={`${itemClass} text-destructive-base hover:bg-destructive-muted/10`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={deleteBlock}
      >
        <RiDeleteBin6Line size={15} className='shrink-0 opacity-70' />
        Delete block
      </button>
    </BlockTypeMenuMainFloat>
  );
};

export default BlockTypeMenu;
