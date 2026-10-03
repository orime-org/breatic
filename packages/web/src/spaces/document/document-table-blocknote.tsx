// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The table block, as this Space ships it.
 *
 * BlockNote's table is an existing Tiptap node (`blocks/Table/block.ts:158`)
 * rather than one built from a propSchema, so a prop added to the schema does
 * not reach the ProseMirror node by itself (`createSpec.ts:182-183`). `quoted`
 * is added here as a node attribute, rendered the way every other block's
 * props are (`data-quoted`), so a quote run passing through a table does not
 * break.
 *
 * The node view is the library's, with two things added around it:
 * - The table sits in a horizontal `ScrollArea`. A table wider than the column
 *   scrolls inside its own block, with the scrollbar every other scroller in
 *   this product has.
 * - `quoted` is re-applied on update. The library's view outlives updates
 *   (column resizing needs it to) and re-applies only `textColor` itself
 *   (`block.ts:274-289`), so without this a table quoted after it was drawn
 *   would keep its old look until the page reloaded.
 */

import { defaultBlockSpecs } from '@blocknote/core';
import type { NodeViewRenderer, NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { ScrollArea } from '@web/components/ui/scroll-area';

/** The DOM attribute `quoted` renders as, the same name its propSchema gives it. */
const QUOTED_ATTRIBUTE = 'data-quoted';

/** A Tiptap node or extension, as far as this module needs to know one. */
interface TiptapExtensionLike {
  readonly name: string;
  extend: (config: Record<string, unknown>) => TiptapExtensionLike;
}

/** The object form of a BlockNote extension, as `createExtension` stores it. */
interface BlockNoteExtensionObject {
  readonly key: string;
  readonly tiptapExtensions?: readonly TiptapExtensionLike[];
}

/** The parts of the library's table spec this module rebuilds. */
interface TableSpec {
  readonly config: { readonly propSchema: Record<string, unknown> };
  readonly implementation: {
    readonly node: {
      extend: (config: Record<string, unknown>) => unknown;
    };
  };
  readonly extensions?: readonly unknown[];
}

/** The library extension that carries the table's row, cell and paragraph nodes. */
const TABLE_NODES_KEY = 'table-extensions';

/**
 * What a row may hold: any number of cells, none included.
 *
 * A row every cell of which is covered by a cell spanning down from above has
 * no cells of its own. prosemirror-tables builds tables that way and its own
 * schema says `*`; BlockNote's row says `+` (`block.ts:356`), so when every
 * cell is merged, ProseMirror fills each emptied row with a blank cell and the
 * table comes out one column wider (upstream #1993).
 */
const ROW_CONTENT = '(tableCell | tableHeader)*';

/**
 * Rebuilds the extension list with the row node allowing an empty row.
 * @param extensions - The library's extensions for the table block.
 * @returns The same list, the row node replaced.
 */
function withEmptyableRows(extensions: readonly unknown[]): unknown[] {
  return extensions.map((factory) => {
    if (typeof factory !== 'function') {
      return factory;
    }
    const made = (factory as () => unknown)() as BlockNoteExtensionObject;
    if (made.key !== TABLE_NODES_KEY || made.tiptapExtensions === undefined) {
      return factory;
    }
    const replaced: BlockNoteExtensionObject = {
      ...made,
      tiptapExtensions: made.tiptapExtensions.map((ext) =>
        ext.name === 'tableRow' ? ext.extend({ content: ROW_CONTENT }) : ext,
      ),
    };
    return (): BlockNoteExtensionObject => replaced;
  });
}

/** The parts of a node view this module wraps. */
interface WrappedView {
  dom: HTMLElement;
  update?: (node: PMNode, ...rest: never[]) => boolean;
  destroy?: () => void;
}

/**
 * Writes `quoted` onto the block's outer element the way its propSchema would.
 * @param dom - The node view's outer element.
 * @param node - The table node.
 */
function applyQuoted(dom: HTMLElement, node: PMNode): void {
  if (node.attrs['quoted'] === true) {
    dom.setAttribute(QUOTED_ATTRIBUTE, 'true');
  } else {
    dom.removeAttribute(QUOTED_ATTRIBUTE);
  }
}

/**
 * Moves the library's `.tableWrapper` into a horizontal `ScrollArea`.
 *
 * The scroll area is rendered synchronously so the wrapper is in place before
 * ProseMirror first reads the view's DOM.
 * @param dom - The node view's outer element, which holds `.tableWrapper`.
 * @returns The React root, to unmount when the view goes.
 */
function mountScroller(dom: HTMLElement): Root | null {
  const wrapper = dom.querySelector(':scope > .tableWrapper');
  if (wrapper === null) {
    return null;
  }
  const host = document.createElement('div');
  host.className = 'doc-table-scroller';
  dom.insertBefore(host, wrapper);
  const root = createRoot(host);
  flushSync(() => {
    root.render(
      <ScrollArea scrollbars='horizontal'>
        <div
          ref={(slot) => {
            if (slot !== null && wrapper.parentElement !== slot) {
              slot.appendChild(wrapper);
            }
          }}
        />
      </ScrollArea>,
    );
  });
  return root;
}

/**
 * Wraps the library's table node view.
 * @param parent - The library's node view renderer.
 * @returns A renderer that adds the scroll area and keeps `quoted` current.
 */
function tableNodeView(parent: NodeViewRenderer): NodeViewRenderer {
  return (props: NodeViewRendererProps) => {
    const view = parent(props) as unknown as WrappedView;
    applyQuoted(view.dom, props.node as PMNode);
    const root = mountScroller(view.dom);

    const update = view.update?.bind(view);
    view.update = (node: PMNode, ...rest: never[]): boolean => {
      if (update === undefined || !update(node, ...rest)) {
        return false;
      }
      applyQuoted(view.dom, node);
      return true;
    };

    const destroy = view.destroy?.bind(view);
    view.destroy = (): void => {
      destroy?.();
      // React refuses a synchronous unmount while it is rendering, and
      // ProseMirror can tear views down from inside a React commit.
      queueMicrotask(() => root?.unmount());
    };

    return view as unknown as ReturnType<NodeViewRenderer>;
  };
}

/**
 * Builds the table block spec with `quoted` and the scroll area.
 * @returns The spec to put under `table` in the schema.
 */
export function buildTableSpec(): typeof defaultBlockSpecs.table {
  const base = defaultBlockSpecs.table as unknown as TableSpec;
  const node = base.implementation.node.extend({
    addAttributes(this: { parent?: () => Record<string, unknown> }) {
      return {
        ...(this.parent?.() ?? {}),
        quoted: {
          default: false,
          keepOnSplit: true,
          parseHTML: (element: HTMLElement): boolean =>
            element.getAttribute(QUOTED_ATTRIBUTE) === 'true',
          renderHTML: (attributes: { quoted?: boolean }): Record<string, string> =>
            attributes.quoted === true ? { [QUOTED_ATTRIBUTE]: 'true' } : {},
        },
      };
    },
    addNodeView(this: { parent?: () => NodeViewRenderer }) {
      const parent = this.parent?.();
      return parent === undefined ? null : tableNodeView(parent);
    },
  });
  return {
    ...base,
    config: {
      ...base.config,
      propSchema: { ...base.config.propSchema, quoted: { default: false } },
    },
    implementation: { ...base.implementation, node },
    extensions: withEmptyableRows(base.extensions ?? []),
  } as unknown as typeof defaultBlockSpecs.table;
}
