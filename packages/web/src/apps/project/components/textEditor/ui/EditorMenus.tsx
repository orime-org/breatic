import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { CellSelection } from '@tiptap/pm/tables';
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
  RiSparkling2Fill,
} from 'react-icons/ri';

interface EditorMenusProps {
  editor: Editor;
}

const formatMenuIconBtnClass = (active: boolean) =>
  [
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors text-icon-base',
    active ? 'bg-background-default-base-hover' : 'hover:bg-background-default-base-hover',
  ].join(' ');

const EditorMenus = ({ editor }: EditorMenusProps) => {
  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  // AI menu state
  const [aiMenuOpen, setAIMenuOpen] = useState(false);
  const [aiAnchorPos, setAiAnchorPos] = useState<number | null>(null);
  // Ref for synchronous check inside shouldShow (avoids stale closure)
  const aiMenuOpenRef = useRef(false);

  const handleCloseAIMenu = useCallback(() => {
    aiMenuOpenRef.current = false;
    setAIMenuOpen(false);
    setAiAnchorPos(null);
    // Restore focus so the user can continue typing
    editor.commands.focus();
  }, [editor]);

  const handleOpenAIMenu = useCallback(() => {
    const { $from, to } = editor.state.selection;

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
        // Anchor to the start of the current block so the AI menu
        // appears above the paragraph instead of covering its content.
        anchorPos = $from.start(d);
        break;
      }
    }

    aiMenuOpenRef.current = true;
    setAiAnchorPos(anchorPos ?? to);
    setAIMenuOpen(true);
  }, [editor]);

  // Wrap shouldShow to hide bubble menu while AI menu is open
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
      // Keep block-editing clean: no formatting bubble inside code-like blocks.
      if (props.editor.isActive('codeBlock') || props.editor.isActive('highlightBlock')) return false;
      return formatBubbleShouldShow(props);
    },
    [],
  );

  useEffect(() => {
    const bridge = getTextEditorBridgeStorage(editor);
    bridge.openSelectionAIMenu = handleOpenAIMenu;
    return () => {
      bridge.openSelectionAIMenu = null;
    };
  }, [editor, handleOpenAIMenu]);

  return (
    <>
      {!aiMenuOpen && (
        <BubbleMenu
          editor={editor}
          className='bubble-menu'
          updateDelay={0}
          shouldShow={shouldShow}
        >
          <BlockTypeSelect editor={editor} />
          <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />

          <Tooltip title='Bold' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={formatMenuIconBtnClass(editor.isActive('bold'))}
            >
              <RiBold size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Italic' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={formatMenuIconBtnClass(editor.isActive('italic'))}
            >
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
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              className={formatMenuIconBtnClass(editor.isActive('strike'))}
            >
              <RiStrikethrough size={16} />
            </button>
          </Tooltip>
          <Tooltip title='Inline code' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.chain().focus().toggleCode().run()}
              className={formatMenuIconBtnClass(editor.isActive('code'))}
            >
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
                <button
                  type='button'
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => editor.chain().focus().mergeCells().run()}
                  className={formatMenuIconBtnClass(false)}
                >
                  <RiMergeCellsHorizontal size={16} />
                </button>
              </Tooltip>
              <Divider type='vertical' className='mx-[2px] h-[18px] shrink-0 self-center' />
            </>
          )}

          {/* Edit with AI button */}
          <Tooltip title='Edit with AI' placement='top' offset={4}>
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleOpenAIMenu}
              className={[
                formatMenuIconBtnClass(aiMenuOpen),
                'text-brand-base',
              ].join(' ')}
              aria-label='Edit with AI'
            >
              <RiSparkling2Fill size={16} />
            </button>
          </Tooltip>
        </BubbleMenu>
      )}

      <ImageBubbleMenu editor={editor} />
      <TableHandles editor={editor} />
      <TableSelectionChrome editor={editor} />

      {/* AI Menu — floats below the selection */}
      {aiMenuOpen && aiAnchorPos != null && (
        <AIMenu editor={editor} anchorPos={aiAnchorPos} onClose={handleCloseAIMenu} />
      )}
    </>
  );
};

export default EditorMenus;
