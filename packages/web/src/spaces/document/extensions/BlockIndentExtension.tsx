import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';

/** Visual indent steps for paragraph / heading (lists use sink / lift). */
export const MAX_BLOCK_INDENT = 8;
const REM_PER_STEP = 1.5;

function selectionInList(editor: Editor): boolean {
  return (
    editor.isActive('bulletList') || editor.isActive('orderedList') || editor.isActive('taskList')
  );
}

function trySinkList(editor: Editor): boolean {
  const can = editor.can();
  if (can.sinkListItem('taskItem')) {
    editor.chain().focus().sinkListItem('taskItem').run();
    return true;
  }
  if (can.sinkListItem('listItem')) {
    editor.chain().focus().sinkListItem('listItem').run();
    return true;
  }
  return false;
}

function tryLiftList(editor: Editor): boolean {
  const can = editor.can();
  if (can.liftListItem('taskItem')) {
    editor.chain().focus().liftListItem('taskItem').run();
    return true;
  }
  if (can.liftListItem('listItem')) {
    editor.chain().focus().liftListItem('listItem').run();
    return true;
  }
  return false;
}

/** Increase indent: nested list when inside a list, otherwise margin on paragraph / heading. */
export function increaseBlockIndent(editor: Editor): boolean {
  if (selectionInList(editor) && trySinkList(editor)) return true;

  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d -= 1) {
    const name = $from.node(d).type.name;
    if (name !== 'paragraph' && name !== 'heading') continue;
    const node = $from.node(d);
    const cur = typeof node.attrs.indent === 'number' ? node.attrs.indent : 0;
    if (cur >= MAX_BLOCK_INDENT) return false;
    const pos = $from.before(d);
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: cur + 1 });
        return true;
      })
      .run();
    return true;
  }
  return false;
}

/** Decrease indent: lift list item when applicable, otherwise reduce margin. */
export function decreaseBlockIndent(editor: Editor): boolean {
  if (selectionInList(editor) && tryLiftList(editor)) return true;

  const { state } = editor;
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d -= 1) {
    const name = $from.node(d).type.name;
    if (name !== 'paragraph' && name !== 'heading') continue;
    const node = $from.node(d);
    const cur = typeof node.attrs.indent === 'number' ? node.attrs.indent : 0;
    if (cur <= 0) return false;
    const pos = $from.before(d);
    const next = cur - 1;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
        return true;
      })
      .run();
    return true;
  }
  return false;
}

/**
 * Adds `indent` (0…MAX_BLOCK_INDENT) to paragraph and heading for non-list “Increase indent”.
 */
export const BlockIndent = Extension.create({
  name: 'blockIndent',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element) => {
              const raw = element.getAttribute('data-indent');
              if (raw == null || raw === '') return 0;
              const n = Number.parseInt(raw, 10);
              if (!Number.isFinite(n) || n < 1) return 0;
              return Math.min(MAX_BLOCK_INDENT, n);
            },
            renderHTML: (attributes) => {
              const n = attributes.indent as number;
              if (!n) return {};
              return {
                'data-indent': String(n),
                style: `margin-left: ${n * REM_PER_STEP}rem`,
              };
            },
          },
        },
      },
    ];
  },
});
