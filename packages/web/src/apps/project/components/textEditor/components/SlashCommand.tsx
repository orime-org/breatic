import { Extension } from '@tiptap/core';
import type { Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import {
  createBreaticSlashMenuPlugin,
  getBreaticSlashCommandRange,
  type BreaticSlashRendererProps,
} from '../slashMenuPlugin';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  RiText,
  RiH1,
  RiH2,
  RiH3,
  RiListUnordered,
  RiListOrdered,
  RiCheckboxLine,
  RiDoubleQuotesL,
  RiCodeBoxLine,
  RiSeparator,
  RiImage2Fill,
  RiTable2,
} from 'react-icons/ri';
import { NodeSelection } from '@tiptap/pm/state';
import { cn } from '@/utils/classnames';
import type { Editor } from '@tiptap/react';
import { openBlockNoteStyleImagePanel } from './BlockNoteImageFilePanel';

export { openBreaticSlashMenu } from '../slashMenuPlugin';

/** Resolve `pendingImage` position after slash insert (mirrors BlockNote insert + file panel). */
const getPendingImagePosAfterInsert = (editor: Editor): number | null => {
  const sel = editor.state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'pendingImage') {
    return sel.from;
  }
  const { $from } = sel;
  for (let d = $from.depth; d > 0; d -= 1) {
    const n = $from.node(d);
    if (n.type.name === 'pendingImage') {
      return $from.before(d);
    }
  }
  const nb = $from.nodeBefore;
  if (nb?.type.name === 'pendingImage') {
    return $from.pos - nb.nodeSize;
  }
  return null;
};

/* ─── Slash command items ─────────────────────────────────────────── */

interface SlashItem {
  title: string;
  subtext?: string;
  group: string;
  icon: React.ReactNode;
  aliases?: string[];
  command: (props: { editor: Editor; range: Range }) => void;
}

const SLASH_ITEMS: SlashItem[] = [
  /* ── Text blocks ─── */
  {
    title: 'Text',
    subtext: 'Plain paragraph',
    group: 'Basic blocks',
    icon: <RiText size={15} />,
    aliases: ['paragraph', 'p'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    subtext: 'Large section heading',
    group: 'Basic blocks',
    icon: <RiH1 size={15} />,
    aliases: ['h1', 'heading1'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    subtext: 'Medium section heading',
    group: 'Basic blocks',
    icon: <RiH2 size={15} />,
    aliases: ['h2', 'heading2'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    subtext: 'Small section heading',
    group: 'Basic blocks',
    icon: <RiH3 size={15} />,
    aliases: ['h3', 'heading3'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    title: 'Bullet List',
    subtext: 'Unordered list',
    group: 'Basic blocks',
    icon: <RiListUnordered size={15} />,
    aliases: ['ul', 'unordered', 'list'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered List',
    subtext: 'Ordered list',
    group: 'Basic blocks',
    icon: <RiListOrdered size={15} />,
    aliases: ['ol', 'ordered', 'numbered'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'Task List',
    subtext: 'Checklist with checkboxes',
    group: 'Basic blocks',
    icon: <RiCheckboxLine size={15} />,
    aliases: ['todo', 'check', 'checkbox', 'task'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    subtext: 'Capture a quote',
    group: 'Basic blocks',
    icon: <RiDoubleQuotesL size={15} />,
    aliases: ['blockquote', 'cite'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code Block',
    subtext: 'Monospace code snippet',
    group: 'Basic blocks',
    icon: <RiCodeBoxLine size={15} />,
    aliases: ['code', 'pre', 'codeblock'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    subtext: 'Horizontal separator line',
    group: 'Basic blocks',
    icon: <RiSeparator size={15} />,
    aliases: ['hr', 'rule', 'line', 'separator'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  /* ── Media & embeds ─── */
  {
    title: 'Image',
    subtext: 'Resizable image with caption',
    group: 'Media',
    icon: <RiImage2Fill size={18} />,
    aliases: ['image', 'imageupload', 'upload', 'img', 'picture', 'media', 'url'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'pendingImage' }).run();
      const pos = getPendingImagePosAfterInsert(editor);
      if (pos == null) return;
      editor.chain().focus().setNodeSelection(pos).run();
      openBlockNoteStyleImagePanel(editor, pos);
    },
  },
  {
    title: 'Table',
    subtext: '3 × 3 table',
    group: 'Media',
    icon: <RiTable2 size={15} />,
    aliases: ['grid', 'rows', 'cols', 'columns'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
];

/* ─── Filter ──────────────────────────────────────────────────────── */

const filterItems = (query: string): SlashItem[] => {
  if (!query) return SLASH_ITEMS;
  const q = query.toLowerCase();
  return SLASH_ITEMS.filter(
    ({ title, aliases }) => title.toLowerCase().includes(q) || aliases?.some((a) => a.includes(q)),
  );
};

/* ─── Menu component ──────────────────────────────────────────────── */

interface SlashMenuListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

const GROUP_ORDER = ['Basic blocks', 'Media'];

/** Scroll container for the text editor — menu must live here to move with content scroll. */
function getSlashMenuPortalRoot(editor: Editor): HTMLElement {
  try {
    const dom = editor.view?.dom as HTMLElement | undefined;
    const wrap = dom?.closest('.breatic-editor-wrapper');
    if (wrap instanceof HTMLElement) return wrap;
  } catch {
    /* `editor.view` can throw before EditorContent mounts */
  }
  return document.body;
}

function slashMenuCoords(
  caretRect: DOMRect | null | undefined,
  portalRoot: HTMLElement,
): { top: number; left: number; position: 'fixed' | 'absolute' } {
  if (portalRoot === document.body) {
    return {
      top: (caretRect?.bottom ?? 0) + 6,
      left: caretRect?.left ?? 0,
      position: 'fixed',
    };
  }
  if (!caretRect) {
    return { top: 0, left: 0, position: 'absolute' };
  }
  const rr = portalRoot.getBoundingClientRect();
  return {
    top: caretRect.bottom - rr.top + portalRoot.scrollTop + 6,
    left: caretRect.left - rr.left + portalRoot.scrollLeft,
    position: 'absolute',
  };
}

const SlashMenuList = forwardRef<SlashMenuListHandle, BreaticSlashRendererProps<SlashItem>>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [, bumpLayout] = useReducer((n: number) => n + 1, 0);
  const editor = props.editor as Editor;

  const portalRoot = useMemo(() => getSlashMenuPortalRoot(editor), [editor]);

  useLayoutEffect(() => {
    const bump = () => bumpLayout();
    if (portalRoot === document.body) {
      window.addEventListener('scroll', bump, true);
      window.addEventListener('resize', bump);
      return () => {
        window.removeEventListener('scroll', bump, true);
        window.removeEventListener('resize', bump);
      };
    }
    portalRoot.addEventListener('scroll', bump, { passive: true });
    window.addEventListener('resize', bump);
    return () => {
      portalRoot.removeEventListener('scroll', bump);
      window.removeEventListener('resize', bump);
    };
  }, [portalRoot]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i - 1 + Math.max(props.items.length, 1)) % Math.max(props.items.length, 1));
        return true;
      }
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % Math.max(props.items.length, 1));
        return true;
      }
      if (event.key === 'Enter') {
        const item = props.items[selectedIndex];
        if (item) {
          const ed = props.editor as Editor;
          const range = getBreaticSlashCommandRange(ed) ?? props.range;
          item.command({ editor: ed, range });
        }
        return true;
      }
      return false;
    },
  }));

  const rect = props.clientRect?.();
  const { top, left, position } = slashMenuCoords(rect, portalRoot);

  if (!props.items.length) {
    return createPortal(
      <div
        style={{ position, top, left, zIndex: 9999 }}
        className='min-w-[200px] rounded-[10px] border border-border-default-base bg-background-default-base px-3 py-2 text-[12px] text-text-default-tertiary shadow-[0_8px_24px_var(--color-shadow-overlay)]'
      >
        No results
      </div>,
      portalRoot,
    );
  }

  // Group items preserving order
  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    items: props.items.filter((item) => item.group === g),
  })).filter(({ items }) => items.length > 0);

  // flat index maps to selectedIndex
  let flatIdx = 0;

  return createPortal(
    <div
      style={{ position, top, left, zIndex: 9999 }}
      className='min-w-[240px] rounded-[10px] border border-border-default-base bg-background-default-base py-1.5 shadow-[0_8px_24px_var(--color-shadow-overlay)]'
    >
      {grouped.map(({ group, items }, gi) => (
        <div key={group}>
          {gi > 0 && <div className='my-1 border-t border-border-default-base' />}
          <p className='px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-default-tertiary select-none'>
            {group}
          </p>
          {items.map((item) => {
            const idx = flatIdx++;
            return (
              <button
                key={item.title}
                type='button'
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-[13px] text-text-default-base',
                  idx === selectedIndex ? 'bg-background-default-secondary' : 'hover:bg-background-default-secondary',
                )}
                onMouseEnter={() => setSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const ed = props.editor as Editor;
                  const range = getBreaticSlashCommandRange(ed) ?? props.range;
                  item.command({ editor: ed, range });
                }}
              >
                <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border-default-base bg-background-default-secondary text-text-default-tertiary'>
                  {item.icon}
                </span>
                <span className='flex flex-col leading-tight'>
                  <span>{item.title}</span>
                  {item.subtext && <span className='text-[11px] text-text-default-tertiary'>{item.subtext}</span>}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>,
    portalRoot,
  );
});

SlashMenuList.displayName = 'SlashMenuList';

/* ─── Tiptap Extension ────────────────────────────────────────────── */

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      createBreaticSlashMenuPlugin<SlashItem>({
        editor,
        items: ({ query }) => filterItems(query),
        render: () => {
          let component: ReactRenderer<SlashMenuListHandle>;

          return {
            onStart(p) {
              component = new ReactRenderer(SlashMenuList, {
                props: p,
                editor: p.editor,
              });
            },
            onUpdate(p) {
              component.updateProps(p);
            },
            onKeyDown({ event }) {
              return component.ref?.onKeyDown({ event }) ?? false;
            },
            onExit() {
              component.destroy();
            },
          };
        },
      }),
    ];
  },
});
