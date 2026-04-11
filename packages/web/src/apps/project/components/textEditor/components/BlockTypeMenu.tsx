import type { RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { RiDeleteBin6Line } from 'react-icons/ri';

const getTopLevelBlockRange = (doc: PMNode, innerBlockStart: number): { start: number; end: number } | null => {
  const safe = Math.min(Math.max(innerBlockStart + 1, 1), doc.content.size);
  const $pos = doc.resolve(safe);
  if ($pos.depth < 1) return null;
  return { start: $pos.before(1), end: $pos.after(1) };
};

const itemClass = 'flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-text-default-base transition-colors hover:bg-background-default-secondary';

const labelClass = 'px-2.5 pt-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-text-default-tertiary select-none';

export interface BlockTypeMenuProps {
  editor: Editor;
  /** Block start doc position — menu commands target this block. */
  anchorBlockStartRef: RefObject<number | null>;
  onClose: () => void;
}

const TURN_INTO_ITEMS = [
  {
    label: 'Text',
    badge: 'T',
    command: (e: Editor) => e.chain().focus().setParagraph().run(),
  },
  {
    label: 'Heading 1',
    badge: 'H1',
    command: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    label: 'Heading 2',
    badge: 'H2',
    command: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    label: 'Heading 3',
    badge: 'H3',
    command: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    label: 'Bullet list',
    badge: '•',
    command: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    badge: '1.',
    command: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    badge: '"',
    command: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    label: 'Code block',
    badge: '</>',
    command: (e: Editor) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: 'Divider',
    badge: '—',
    command: (e: Editor) => e.chain().focus().setHorizontalRule().run(),
  },
] as const;

/** Block options menu — opened by clicking the ⠿ drag handle. */
const BlockTypeMenu = ({ editor, anchorBlockStartRef, onClose }: BlockTypeMenuProps) => {
  const focusAnchorBlock = () => {
    const bs = anchorBlockStartRef.current;
    if (bs != null)
      editor
        .chain()
        .focus()
        .setTextSelection(bs + 1)
        .run();
  };

  const run = (fn: () => void) => {
    focusAnchorBlock();
    fn();
    onClose();
  };

  const deleteBlock = () => {
    const bs = anchorBlockStartRef.current;
    if (bs == null) {
      onClose();
      return;
    }
    const range = getTopLevelBlockRange(editor.state.doc, bs);
    if (!range) {
      onClose();
      return;
    }
    editor.view.dispatch(editor.state.tr.delete(range.start, range.end));
    editor.commands.focus();
    onClose();
  };

  return (
    <div
      className='absolute left-0 top-full z-[9997] mt-1 min-w-[192px] rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)]'
      role='menu'
    >
      {/* Delete */}
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

      {/* Separator */}
      <div className='my-1.5 border-t border-border-default-base' />

      {/* Turn into */}
      <p className={labelClass}>Turn into</p>
      {TURN_INTO_ITEMS.map(({ label, badge, command }) => (
        <button
          key={label}
          type='button'
          role='menuitem'
          className={itemClass}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => run(() => command(editor))}
        >
          <span className='w-6 text-center text-xs font-semibold text-text-default-tertiary'>{badge}</span>
          {label}
        </button>
      ))}
    </div>
  );
};

export default BlockTypeMenu;
