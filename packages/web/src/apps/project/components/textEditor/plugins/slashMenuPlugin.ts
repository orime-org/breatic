/**
 * Slash menu trigger: typed "/" stays in the document with an inline decoration on that character.
 * Programmatic open passes deleteTriggerCharacter: false (no "/" in the doc, block decoration, placeholder visible).
 */
import { findParentNode } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const breaticSlashMenuKey = new PluginKey<BreaticSlashMenuState>('breaticSlashMenu');

export type BreaticSlashMenuState = {
  triggerCharacter: string;
  /** false = opened via + button: no "/" in document, block decoration */
  deleteTriggerCharacter: boolean;
  /** Start of filter query (after "/" when deleteTriggerCharacter is true) */
  queryStart: number;
  query: string;
  decorationId: string;
} | null;

type SlashMetaOpen = {
  triggerCharacter: string;
  deleteTriggerCharacter?: boolean;
};

const findTextBlock = findParentNode((node) =>
  ['paragraph', 'heading', 'blockquote', 'codeBlock'].includes(node.type.name),
);

function slashCommandRange(state: EditorState, pm: NonNullable<BreaticSlashMenuState>): Range {
  const { from } = state.selection;
  const start = pm.deleteTriggerCharacter ? pm.queryStart - pm.triggerCharacter.length : pm.queryStart;
  return { from: start, to: from };
}

export type BreaticSlashMenuPluginProps<I> = {
  editor: Editor;
  pluginKey?: PluginKey<BreaticSlashMenuState>;
  items: (props: { query: string; editor: Editor }) => I[] | Promise<I[]>;
  render: () => {
    onBeforeStart?: (props: BreaticSlashRendererProps<I>) => void;
    onStart?: (props: BreaticSlashRendererProps<I>) => void;
    onBeforeUpdate?: (props: BreaticSlashRendererProps<I>) => void;
    onUpdate?: (props: BreaticSlashRendererProps<I>) => void;
    onExit?: (props: BreaticSlashRendererProps<I>) => void;
    onKeyDown?: (props: { view: EditorView; event: KeyboardEvent; range: Range }) => boolean;
  };
};

export type BreaticSlashRendererProps<I> = {
  editor: Editor;
  range: Range;
  query: string;
  items: I[];
  decorationNode: Element | null;
  clientRect?: (() => DOMRect | null) | null;
};

export function openBreaticSlashMenu(
  editor: Editor,
  options?: { deleteTriggerCharacter?: boolean },
  pluginKey: PluginKey<BreaticSlashMenuState> = breaticSlashMenuKey,
) {
  const view = editor.view;
  if (!view) return;
  const deleteTriggerCharacter = options?.deleteTriggerCharacter ?? false;
  // Single transaction like BlockNote `openSuggestionMenu` (focus + optional "/" + meta + scroll).
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      if (deleteTriggerCharacter) {
        tr.insertText('/');
      }
      tr.setMeta(pluginKey, {
        triggerCharacter: '/',
        deleteTriggerCharacter,
      } satisfies SlashMetaOpen).scrollIntoView();
      return true;
    })
    .run();
}

export function closeBreaticSlashMenu(view: EditorView, pluginKey = breaticSlashMenuKey) {
  view.dispatch(view.state.tr.setMeta(pluginKey, null));
}

export function getBreaticSlashCommandRange(
  editor: Editor,
  pluginKey: PluginKey<BreaticSlashMenuState> = breaticSlashMenuKey,
): Range | null {
  const pm = pluginKey.getState(editor.state);
  if (!pm) return null;
  return slashCommandRange(editor.state, pm);
}

export function createBreaticSlashMenuPlugin<I>({
  editor,
  pluginKey = breaticSlashMenuKey,
  items: itemsFn,
  render,
}: BreaticSlashMenuPluginProps<I>) {
  const renderer = render?.();
  let props: BreaticSlashRendererProps<I> | undefined;

  const getAnchorClientRect = () => {
    const pos = editor.state.selection.$anchor.pos;
    const coords = editor.view.coordsAtPos(pos);
    const { top, right, bottom, left } = coords;
    try {
      return new DOMRect(left, top, right - left, bottom - top);
    } catch {
      return null;
    }
  };

  const clientRectFor = (view: EditorView, decorationNode: Element | null) => {
    if (!decorationNode) {
      return () => getAnchorClientRect();
    }
    return () => decorationNode.getBoundingClientRect() || null;
  };

  const plugin: Plugin<BreaticSlashMenuState> = new Plugin<BreaticSlashMenuState>({
    key: pluginKey,

    view: () => ({
      update: async (view, prevState) => {
        const prev = pluginKey.getState(prevState);
        const next = pluginKey.getState(view.state);

        const started = !prev && next;
        const stopped = prev && !next;
        const changed = prev && next && (prev.query !== next.query || prev.queryStart !== next.queryStart);

        if (!started && !stopped && !changed) return;

        if (stopped || !editor.isEditable) {
          if (props) renderer?.onExit?.(props);
          props = undefined;
          return;
        }

        const pm = next!;
        const decorationNode = view.dom.querySelector(`[data-decoration-id="${pm.decorationId}"]`);

        const range = slashCommandRange(view.state, pm);
        const base: Omit<BreaticSlashRendererProps<I>, 'items'> = {
          editor,
          range,
          query: pm.query,
          decorationNode,
          clientRect: clientRectFor(view, decorationNode),
        };

        if (started || changed) {
          const list = await itemsFn({ query: pm.query, editor });
          props = { ...base, items: list };

          if (started) {
            renderer?.onBeforeStart?.(props);
            renderer?.onStart?.(props);
          } else {
            renderer?.onBeforeUpdate?.(props);
            renderer?.onUpdate?.(props);
          }
        }
      },

      destroy: () => {
        if (props) renderer?.onExit?.(props);
      },
    }),

    state: {
      init(): BreaticSlashMenuState {
        return null;
      },

      apply(transaction, prev, _oldState, newState): BreaticSlashMenuState {
        if (transaction.selection.$from.parent.type.spec.code) {
          return prev;
        }

        const meta: SlashMetaOpen | null | undefined = transaction.getMeta(pluginKey);

        if (meta === null) {
          return null;
        }

        if (meta && typeof meta === 'object' && 'triggerCharacter' in meta && meta.triggerCharacter) {
          const deleteTriggerCharacter = meta.deleteTriggerCharacter !== false;
          return {
            triggerCharacter: meta.triggerCharacter,
            deleteTriggerCharacter,
            queryStart: newState.selection.from,
            query: '',
            decorationId: `id_${Math.floor(Math.random() * 0xffffffff)}`,
          };
        }

        if (prev === null) {
          return null;
        }

        let queryStart = prev.queryStart;
        if (transaction.docChanged) {
          queryStart = transaction.mapping.map(queryStart);
        }

        if (prev.deleteTriggerCharacter) {
          const t = prev.triggerCharacter;
          const len = t.length;
          if (len === 0 || queryStart < len || queryStart > newState.doc.content.size) {
            return null;
          }
          const slashFrom = queryStart - len;
          try {
            if (newState.doc.textBetween(slashFrom, queryStart) !== t) {
              return null;
            }
          } catch {
            return null;
          }
        }

        const sel = newState.selection;
        // "+" palette opened on a media/atom block: keep plugin state until the user moves
        // to a text caret (sameParent / textBetween checks do not apply to NodeSelection).
        if (prev.deleteTriggerCharacter === false && sel instanceof NodeSelection) {
          return prev;
        }

        // Do not use `sel.from !== sel.to`: NodeSelection is always a range and would
        // instantly clear the menu. Only treat non-empty text ranges as "left the caret".
        const hasNonEmptyTextRange = sel instanceof TextSelection && !sel.empty;
        if (
          hasNonEmptyTextRange ||
          transaction.getMeta('blur') ||
          transaction.getMeta('pointer') ||
          sel.from < queryStart ||
          !sel.$from.sameParent(newState.doc.resolve(queryStart))
        ) {
          return null;
        }

        return {
          ...prev,
          queryStart,
          query: newState.doc.textBetween(queryStart, sel.from),
        };
      },
    },

    props: {
      handleTextInput(view, from, to, text) {
        if (from !== to || text !== '/') {
          return false;
        }
        const tr = view.state.tr.insertText('/').setMeta(pluginKey, { triggerCharacter: '/' }).scrollIntoView();
        view.dispatch(tr);
        return true;
      },

      handleKeyDown(view, event) {
        const pm = pluginKey.getState(view.state);
        if (!pm) {
          return false;
        }

        const range = slashCommandRange(view.state, pm);

        if (event.key === 'Escape' || event.key === 'Esc') {
          closeBreaticSlashMenu(view, pluginKey);
          return true;
        }

        return renderer?.onKeyDown?.({ view, event, range }) ?? false;
      },

      decorations(state) {
        const pm = pluginKey.getState(state);
        if (!pm) {
          return null;
        }

        if (!pm.deleteTriggerCharacter) {
          const block = findTextBlock(state.selection);
          if (block) {
            return DecorationSet.create(state.doc, [
              Decoration.node(block.pos, block.pos + block.node.nodeSize, {
                nodeName: 'span',
                class: 'breatic-slash-suggestion-decorator',
                'data-decoration-id': pm.decorationId,
              }),
            ]);
          }
          const sel = state.selection;
          if (sel instanceof NodeSelection && sel.node.isBlock) {
            const { from, node } = sel;
            return DecorationSet.create(state.doc, [
              Decoration.node(from, from + node.nodeSize, {
                nodeName: 'span',
                class: 'breatic-slash-suggestion-decorator',
                'data-decoration-id': pm.decorationId,
              }),
            ]);
          }
          return null;
        }

        const from = pm.queryStart - pm.triggerCharacter.length;
        const to = pm.queryStart;
        return DecorationSet.create(state.doc, [
          Decoration.inline(from, to, {
            nodeName: 'span',
            class: 'suggestion',
            'data-decoration-id': pm.decorationId,
          }),
        ]);
      },
    },
  });

  return plugin;
}
