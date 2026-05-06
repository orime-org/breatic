import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { CellSelection } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import Divider from '@/ui/divider';
import Tooltip from '@/ui/tooltip';
import BlockTypeSelect from '../formatting/BlockTypeSelect';
import TextColorSelect from '../formatting/TextColorSelect';
import TableHandles from '../table/TableHandles';
import TableSelectionChrome from '../table/TableSelectionChrome';
import ImageBubbleMenu, { formatBubbleShouldShow } from '../media/ImageBubbleMenu';
import AIMenu from './AIMenu';
import { ImproveMenuTrigger } from './ImproveMenuTrigger';
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
} from 'react-icons/ri';

interface EditorMenusProps {
  editor: Editor;
  /** When the canvas generation `AIMenu` is open (e.g. right toolbar / Ask AI), hide the format bubble. */
  generationAIMenuOpen?: boolean;
}

const formatMenuIconBtnClass = (active: boolean) =>
  [
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors text-icon-base',
    active ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover',
  ].join(' ');

const EditorMenus = ({ editor, generationAIMenuOpen = false }: EditorMenusProps) => {
  type SelectionRange = { from: number; to: number };
  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  const [aiMenuOpen, setAIMenuOpen] = useState(false);
  const [aiAnchorPos, setAiAnchorPos] = useState<number | null>(null);
  const [aiInitialReplacement, setAiInitialReplacement] = useState<string | null>(null);
  const aiMenuOpenRef = useRef(false);

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
      if (generationAIMenuOpen) return false;
      if (props.editor.isActive('codeBlock')) return false;
      return formatBubbleShouldShow(props);
    },
    [generationAIMenuOpen],
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
      getTextEditorBridgeStorage(editor).openGenerationAIMenu?.(null);
    };
    return () => {
      bridge.openSelectionAIMenu = null;
    };
  }, [editor, openAIMenuFromSelection]);

  return (
    <>
      {!aiMenuOpen && !generationAIMenuOpen && (
        <BubbleMenu editor={editor} className='bubble-menu' updateDelay={0} shouldShow={shouldShow}>
          <ImproveMenuTrigger onQuickAction={(replacement: string) => openAIMenuFromSelection(replacement)} />
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
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

          {editor.state.selection instanceof CellSelection && editor.can().mergeCells() && (
            <>
              <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
              <Tooltip title='Merge cells' placement='top' offset={4}>
                <button type='button' onMouseDown={(e) => e.preventDefault()} onClick={() => editor.chain().focus().mergeCells().run()} className={formatMenuIconBtnClass(false)}>
                  <RiMergeCellsHorizontal size={16} />
                </button>
              </Tooltip>
            </>
          )}
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
