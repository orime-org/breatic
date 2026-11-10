// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Folds the unchanged stretches of a snapshot comparison (inner#1129 design
 * §7.3), as Confluence's page comparison does: a long run of top-level blocks
 * without any change collapses to one row the user can open.
 *
 * Everything here is decoration on the read-only preview editor; the
 * document is never changed. The row's button is drawn by React through a
 * portal into the widget's host element (`DocumentVersionPreview`), since a
 * widget can only hold plain DOM.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** Unchanged blocks kept open beside each change. */
const CONTEXT_BLOCKS = 1;
/** Fewest hidden blocks worth a fold row. */
const MIN_FOLDED = 3;

/** One folded stretch. */
export interface VersionFold {
  /** The first hidden block's id, which names the fold. */
  readonly key: string;
  /** How many blocks it hides. */
  readonly count: number;
}

interface FoldState {
  readonly folds: readonly VersionFold[];
  readonly decorations: DecorationSet;
  /** Folds the user opened; cleared when the comparison changes. */
  readonly opened: ReadonlySet<string>;
}

const NO_FOLDS: readonly VersionFold[] = [];

export const versionFoldKey = new PluginKey<FoldState>('doc-version-fold');

/**
 * Whether a node or anything inside it carries a comparison mark.
 * @param node - The node.
 * @returns True when it changed.
 */
function changed(node: PMNode): boolean {
  let found = node.marks.some((mark) => mark.type.name.startsWith('y-attributed-'));
  node.descendants((child) => {
    if (found) return false;
    found = child.marks.some((mark) => mark.type.name.startsWith('y-attributed-'));
    return !found;
  });
  return found;
}

/**
 * The folds and their decorations for a document.
 * @param doc - The preview's document.
 * @param opened - Folds the user opened.
 * @returns The state.
 */
function foldsOf(doc: PMNode, opened: ReadonlySet<string>): FoldState {
  const group = doc.firstChild;
  const blocks: { node: PMNode; pos: number }[] = [];
  group?.forEach((node, offset) => blocks.push({ node, pos: offset + 1 }));
  const flags = blocks.map((block) => changed(block.node));
  const folds: VersionFold[] = [];
  const decorations: Decoration[] = [];
  // Not comparing: nothing carries a mark, and the preview shows in full.
  if (flags.includes(true)) {
    let start = 0;
    while (start < blocks.length) {
      if (flags[start]) {
        start += 1;
        continue;
      }
      let end = start;
      while (end + 1 < blocks.length && !flags[end + 1]) end += 1;
      const from = start === 0 ? start : start + CONTEXT_BLOCKS;
      const to = end === blocks.length - 1 ? end : end - CONTEXT_BLOCKS;
      const count = to - from + 1;
      const first = blocks[from];
      const key = first === undefined ? '' : String(first.node.attrs.id);
      if (count >= MIN_FOLDED && first !== undefined && !opened.has(key)) {
        folds.push({ key, count });
        decorations.push(Decoration.widget(first.pos, () => foldHost(key), { key: `doc-version-fold:${key}`, side: -1, ignoreSelection: true }));
        for (let i = from; i <= to; i += 1) {
          const { node, pos } = blocks[i]!;
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'doc-version-folded' }));
        }
      }
      start = end + 1;
    }
  }
  return { folds, decorations: DecorationSet.create(doc, decorations), opened };
}

/**
 * The element a fold row's button is drawn into.
 * @param key - The fold.
 * @returns The host.
 */
function foldHost(key: string): HTMLElement {
  const host = document.createElement('div');
  host.dataset.versionFold = key;
  host.contentEditable = 'false';
  return host;
}

const versionFold = new Plugin<FoldState>({
  key: versionFoldKey,
  state: {
    init: (_config, state) => foldsOf(state.doc, new Set()),
    apply(tr: Transaction, prev: FoldState): FoldState {
      const open = tr.getMeta(versionFoldKey) as string | undefined;
      if (tr.docChanged) return foldsOf(tr.doc, new Set());
      if (open !== undefined) return foldsOf(tr.doc, new Set([...prev.opened, open]));
      return prev;
    },
  },
  props: { decorations: (state) => versionFoldKey.getState(state)?.decorations },
});

/**
 * The folds a preview shows now.
 * @param state - The preview editor's state.
 * @returns The folds, in document order.
 */
export function versionFolds(state: EditorState): readonly VersionFold[] {
  return versionFoldKey.getState(state)?.folds ?? NO_FOLDS;
}

/**
 * Opens a fold; it stays open until the comparison changes.
 * @param state - The preview editor's state.
 * @param key - The fold.
 * @returns The transaction to dispatch.
 */
export function openVersionFold(state: EditorState, key: string): Transaction {
  return state.tr.setMeta(versionFoldKey, key);
}

export const documentVersionFoldExtension = createExtension(() => ({
  key: 'documentVersionFold',
  prosemirrorPlugins: [versionFold],
}) as never);
