import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { CellSelection } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import BlockTypeSelect from '../formatting/BlockTypeSelect';
import TextColorSelect from '../formatting/TextColorSelect';
import TableHandles from '../table/TableHandles';
import TableSelectionChrome from '../table/TableSelectionChrome';
import ImageBubbleMenu, { formatBubbleShouldShow } from '../media/ImageBubbleMenu';
import AIMenu from './AIMenu';
import { getTextEditorBridgeStorage } from '../extensions/TextEditorBridgeExtension';
import {
  RiBold,
  RiItalic,
  RiUnderline,
  RiStrikethrough,
  RiCodeLine,
  RiAlignLeft,
  RiAlignCenter,
  RiAlignRight,
  RiMergeCellsHorizontal,
  RiEdit2Line,
  RiListCheck2,
  RiMagicLine,
  RiSparkling2Fill,
  RiTranslate2,
} from 'react-icons/ri';
import { LiaExpandSolid } from 'react-icons/lia';
import { MdOutlinePlaylistAdd } from 'react-icons/md';

interface EditorMenusProps {
  editor: Editor;
}

type SelectionAIAction = {
  key: string;
  title: string;
  icon: ReactNode;
  replacement: string;
};

const formatMenuIconBtnClass = (active: boolean) =>
  [
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors text-icon-base',
    active ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover',
  ].join(' ');

const EditorMenus = ({ editor }: EditorMenusProps) => {
  type SelectionRange = { from: number; to: number };
  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const [aiMenuOpen, setAIMenuOpen] = useState(false);
  const [aiAnchorPos, setAiAnchorPos] = useState<number | null>(null);
  const [aiInitialReplacement, setAiInitialReplacement] = useState<string | null>(null);
  const aiMenuOpenRef = useRef(false);

  const [selectionAIMenuOpen, setSelectionAIMenuOpen] = useState(false);
  const selectionAIMenuRef = useRef<HTMLDivElement>(null);

  const selectionAIActions = useMemo<SelectionAIAction[]>(
    () => [
      { key: 'polish', title: 'polish', icon: <RiMagicLine size={16} />, replacement: '[POLISH] This is fixed replacement content.' },
      { key: 'expand', title: 'expand', icon: <LiaExpandSolid size={16} />, replacement: '[EXPAND] This is fixed replacement content.' },
      { key: 'summarize', title: 'summarize', icon: <RiListCheck2 size={16} />, replacement: '[SUMMARIZE] This is fixed replacement content.' },
      { key: 'translate', title: 'translate', icon: <RiTranslate2 size={16} />, replacement: '[TRANSLATE] This is fixed replacement content.' },
      { key: 'rewrite', title: 'rewrite', icon: <RiEdit2Line size={16} />, replacement: '[REWRITE] This is fixed replacement content.' },
      { key: 'continue', title: 'continue', icon: <MdOutlinePlaylistAdd size={16} />, replacement: '[CONTINUE] This is fixed replacement content.' },
    ],
    [],
  );

  const openAIMenuFromSelection = useCallback(
    (initialReplacement: string | null, explicitRange?: SelectionRange) => {
      let from: number;
      let to: number;
      if (explicitRange) {
        from = Math.min(explicitRange.from, explicitRange.to);
        to = Math.max(explicitRange.from, explicitRange.to);
        if (to <= from) return;
        // Suppress format bubble before changing selection, then open AI menu directly.
        aiMenuOpenRef.current = true;
        editor.chain().focus().setTextSelection({ from, to }).run();
      } else {
        const sel = editor.state.selection;
        if (!(sel instanceof TextSelection) || sel.empty) return;
        from = Math.min(sel.from, sel.to);
        to = Math.max(sel.from, sel.to);
      }

      const $from = editor.state.doc.resolve(from);
      const blockTypesForAIMenuAnchor = new Set([
        'paragraph',
        'heading',
        'blockquote',
        'codeBlock',
        'listItem',
        'taskItem',
      ]);

      let anchorPos: number | null = null;
      for (let d = $from.depth; d >= 1; d -= 1) {
        const node = $from.node(d);
        if (blockTypesForAIMenuAnchor.has(node.type.name)) {
          anchorPos = $from.start(d);
          break;
        }
      }

      aiMenuOpenRef.current = true;
      setAiAnchorPos(anchorPos ?? to);
      setAiInitialReplacement(initialReplacement);
      setAIMenuOpen(true);
    },
    [editor],
  );

  const handleCloseAIMenu = useCallback(() => {
    aiMenuOpenRef.current = false;
    setAIMenuOpen(false);
    setAiAnchorPos(null);
    setAiInitialReplacement(null);
    editor.commands.focus();
  }, [editor]);

  const runSelectionAIAction = useCallback(
    (replacement: string) => {
      setSelectionAIMenuOpen(false);
      openAIMenuFromSelection(replacement);
    },
    [openAIMenuFromSelection],
  );

  const shouldShow = useCallback(
    (props: {
      editor: Editor;
      element: HTMLElement;
      view: EditorView;
      state: EditorState;
      from: number;
      to: number;
    }) => {
      if (aiMenuOpenRef.current) return false;
      if (props.editor.isActive('codeBlock')) return false;
      return formatBubbleShouldShow(props);
    },
    [],
  );

  useEffect(() => {
    const bridge = getTextEditorBridgeStorage(editor);
    bridge.openSelectionAIMenu = (options) => {
      const initialReplacement = options?.initialReplacement ?? null;
      const explicitRange = options?.range;
      if (initialReplacement || explicitRange) {
        openAIMenuFromSelection(initialReplacement, explicitRange);
        return;
      }
      setSelectionAIMenuOpen(true);
    };
    return () => {
      bridge.openSelectionAIMenu = null;
    };
  }, [editor, openAIMenuFromSelection]);

  useEffect(() => {
    if (!selectionAIMenuOpen) return;
    const onPointerDownOutside = (e: MouseEvent) => {
      if (selectionAIMenuRef.current?.contains(e.target as Node)) return;
      setSelectionAIMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDownOutside);
    return () => document.removeEventListener('mousedown', onPointerDownOutside);
  }, [selectionAIMenuOpen]);

  return (
    <>
      {!aiMenuOpen && (
        <BubbleMenu editor={editor} className='bubble-menu' updateDelay={0} shouldShow={shouldShow}>
          <BlockTypeSelect editor={editor} />
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />

          <Tooltip title='Bold' placement='top' offset={4}>
            <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()} className={formatMenuIconBtnClass(editor.isActive('bold'))}>
              <RiBold size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Italic' placement='top' offset={4}>
            <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()} className={formatMenuIconBtnClass(editor.isActive('italic'))}>
              <RiItalic size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Underline' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (editor.chain().focus() as any).toggleUnderline().run()
              }
              className={formatMenuIconBtnClass(editor.isActive('underline'))}
            >
              <RiUnderline size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Strikethrough' placement='top' offset={4}>
            <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()} className={formatMenuIconBtnClass(editor.isActive('strike'))}>
              <RiStrikethrough size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Inline code' placement='top' offset={4}>
            <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().toggleCode().run()} className={formatMenuIconBtnClass(editor.isActive('code'))}>
              <RiCodeLine size={16} />
            </button>
          </Tooltip>
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
          <TextColorSelect editor={editor} />
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />

          <Tooltip title='Align left' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (editor.chain().focus() as any).setTextAlign('left').run()
              }
              className={formatMenuIconBtnClass(editor.isActive({ textAlign: 'left' }))}
            >
              <RiAlignLeft size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Align center' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (editor.chain().focus() as any).setTextAlign('center').run()
              }
              className={formatMenuIconBtnClass(editor.isActive({ textAlign: 'center' }))}
            >
              <RiAlignCenter size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Align right' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (editor.chain().focus() as any).setTextAlign('right').run()
              }
              className={formatMenuIconBtnClass(editor.isActive({ textAlign: 'right' }))}
            >
              <RiAlignRight size={16} />
            </button>
          </Tooltip>
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />

          {editor.state.selection instanceof CellSelection && editor.can().mergeCells() && (
            <>
              <Tooltip title='Merge cells' placement='top' offset={4}>
                <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().mergeCells().run()} className={formatMenuIconBtnClass(false)}>
                  <RiMergeCellsHorizontal size={16} />
                </button>
              </Tooltip>
              <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
            </>
          )}

          <div ref={selectionAIMenuRef} className='relative'>
            <Tooltip title='Ask AI' placement='top' offset={4}>
              <button
                type='button'
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSelectionAIMenuOpen((v) => !v)}
                className={[formatMenuIconBtnClass(selectionAIMenuOpen), 'text-brand-base'].join(' ')}
                aria-label='Ask AI'
              >
                <RiSparkling2Fill size={16} />
              </button>
            </Tooltip>

            {selectionAIMenuOpen && (
              <div className='absolute right-0 top-full z-[101] mt-1 min-w-[200px] rounded-[8px] border border-border-default-base bg-background-default-base py-1 shadow-[0px_8px_24px_-8px_rgba(12,12,13,0.25)]'>
                {selectionAIActions.map((item) => (
                  <button
                    key={item.key}
                    type='button'
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runSelectionAIAction(item.replacement)}
                    className='flex min-h-8 w-full cursor-pointer items-center gap-2.5 border-0 px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary'
                  >
                    <span className='inline-flex shrink-0 text-icon-base'>{item.icon}</span>
                    {item.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </BubbleMenu>
      )}

      <ImageBubbleMenu editor={editor} />
      <TableHandles editor={editor} />
      <TableSelectionChrome editor={editor} />

      {aiMenuOpen && aiAnchorPos != null && (
        <AIMenu
          editor={editor}
          anchorPos={aiAnchorPos}
          onClose={handleCloseAIMenu}
          initialReplacement={aiInitialReplacement}
        />
      )}
    </>
  );
};

export default EditorMenus;
