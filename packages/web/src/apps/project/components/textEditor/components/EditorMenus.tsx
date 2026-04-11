import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import Divider from '@/components/base/divider';
import Tooltip from '@/components/base/tooltip';
import BlockTypeSelect from './BlockTypeSelect';
import TextColorSelect from './TextColorSelect';
import {
  RiBold,
  RiItalic,
  RiUnderline,
  RiStrikethrough,
  RiCodeLine,
  RiAlignLeft,
  RiAlignCenter,
  RiAlignRight,
  RiMarkPenLine,
} from 'react-icons/ri';

interface EditorMenusProps {
  editor: Editor;
}

const formatMenuIconBtnClass = (active: boolean) =>
  [
    'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-0 transition-colors',
    active
      ? 'bg-[var(--color-brand-base)] text-[var(--color-text-on-button-base)]'
      : 'text-icon-base hover:bg-background-default-base-hover',
  ].join(' ');

const EditorMenus = ({ editor }: EditorMenusProps) => {
  useEditorState({
    editor,
    selector: ({ transactionNumber }) => transactionNumber,
  });

  return (
    <BubbleMenu editor={editor} className='bubble-menu'>
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

      <Tooltip title='Highlight' placement='top' offset={4}>
        <button
          type='button'
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (editor.chain().focus() as any).toggleHighlight().run()
          }
          className={formatMenuIconBtnClass(editor.isActive('highlight'))}
        >
          <RiMarkPenLine size={16} />
        </button>
      </Tooltip>
    </BubbleMenu>
  );
};

export default EditorMenus;
