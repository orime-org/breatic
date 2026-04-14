import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface HeadingFoldPluginState {
  collapsed: ReadonlySet<number>;
}

export const headingFoldKey = new PluginKey<HeadingFoldPluginState>('headingFold');

/**
 * Whether the fold chevron appears in the gutter for this doc position (h1–h3 with
 * section content below). Matches BlockLineControl gutter fold visibility.
 */
export function headingFoldArrowVisible(view: EditorView, blockStart: number): boolean {
  const { doc } = view.state;
  if (blockStart < 0 || blockStart > doc.content.size) return false;

  const inner = Math.min(Math.max(blockStart + 1, 1), doc.content.size);
  const $pos = doc.resolve(inner);
  if ($pos.depth < 1 || $pos.before(1) !== blockStart) return false;

  const node = doc.nodeAt(blockStart);
  if (!node || node.type.name !== 'heading') return false;
  const level = node.attrs.level as number;
  if (level > 3) return false;

  const dom = view.nodeDOM(blockStart) as HTMLElement | null;
  if (!dom || dom.style.display === 'none') return false;

  let hasContent = false;
  let pastStop = false;
  doc.forEach((n, o) => {
    if (pastStop || hasContent) return;
    if (o <= blockStart) return;
    if (n.type.name === 'heading' && (n.attrs.level as number) <= level) {
      pastStop = true;
      return;
    }
    hasContent = true;
  });
  return hasContent;
}

/**
 * For a collapsed heading at `headingStart` with `headingLevel`, returns the
 * doc range [from, to) that should be hidden — i.e. everything after the heading
 * up to (but not including) the next same-or-higher-level heading.
 */
const getCollapsedRange = (
  doc: PMNode,
  headingStart: number,
  headingLevel: number,
): { from: number; to: number } | null => {
  let headingEnd: number | null = null;
  let sectionEnd = doc.content.size;

  doc.forEach((node, offset) => {
    if (headingEnd == null) {
      // Still looking for our heading
      if (offset === headingStart) headingEnd = offset + node.nodeSize;
      return;
    }
    // We are past the heading — find where the section ends
    if (node.type.name === 'heading' && (node.attrs.level as number) <= headingLevel) {
      if (offset < sectionEnd) sectionEnd = offset;
    }
  });

  if (headingEnd == null || sectionEnd <= headingEnd) return null;
  return { from: headingEnd, to: sectionEnd };
};

export const HeadingFold = Extension.create({
  name: 'headingFold',

  addProseMirrorPlugins() {
    return [
      new Plugin<HeadingFoldPluginState>({
        key: headingFoldKey,

        state: {
          init: (): HeadingFoldPluginState => ({ collapsed: new Set() }),

          apply(tr, prev): HeadingFoldPluginState {
            const meta = tr.getMeta(headingFoldKey) as { pos: number } | null | undefined;
            if (!meta && !tr.docChanged) return prev;

            // Remap positions when the document changes (insertions/deletions shift offsets)
            let working: Set<number>;
            if (tr.docChanged && prev.collapsed.size > 0) {
              working = new Set();
              prev.collapsed.forEach((pos) => {
                const mapped = tr.mapping.map(pos, 1);
                // Drop the position if it no longer points at a heading
                if (tr.doc.nodeAt(mapped)?.type.name === 'heading') {
                  working.add(mapped);
                }
              });
            } else {
              working = new Set(prev.collapsed);
            }

            // Apply toggle from the button click
            if (meta != null) {
              if (working.has(meta.pos)) {
                working.delete(meta.pos);
              } else {
                working.add(meta.pos);
              }
            }

            return { collapsed: working };
          },
        },

        props: {
          decorations(state): DecorationSet {
            const pluginState = headingFoldKey.getState(state);
            if (!pluginState || pluginState.collapsed.size === 0) return DecorationSet.empty;

            const { doc } = state;
            const decos: Decoration[] = [];

            pluginState.collapsed.forEach((headingStart) => {
              const node = doc.nodeAt(headingStart);
              if (!node || node.type.name !== 'heading') return;

              const range = getCollapsedRange(doc, headingStart, node.attrs.level as number);
              if (!range) return;

              // Apply display:none to every top-level block in the collapsed range
              doc.forEach((n, o) => {
                if (o < range.from || o >= range.to) return;
                decos.push(Decoration.node(o, o + n.nodeSize, { style: 'display:none' }));
              });
            });

            // DecorationSet.create requires decorations sorted by position
            decos.sort((a, b) => a.from - b.from);
            return DecorationSet.create(doc, decos);
          },
        },
      }),
    ];
  },
});

/** Toggle the folded state of the heading whose doc start position is `headingPos`. */
export const toggleHeadingFold = (view: EditorView, headingPos: number): void => {
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { pos: headingPos }));
};
