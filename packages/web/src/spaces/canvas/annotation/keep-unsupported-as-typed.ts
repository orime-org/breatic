// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A remark plugin that hands back, verbatim, every piece of markdown an
 * annotation does not draw.
 *
 * An annotation understands six marks (#1881 §11.2, the set Figma's comments
 * settle on): bold, italic, strikethrough, links, and the two kinds of list.
 * Everything else the parser recognises — a heading, a fence, a quote, a rule,
 * a table, an image, inline backticks — is turned back into the characters
 * that produced it.
 *
 * Turning it back rather than hiding it is the point. `allowedElements` alone
 * drops the element and everything inside it, so `# ship it` would render as
 * nothing at all, and `unwrapDisallowed` renders `ship it` — the `#` gone and
 * the author's meaning quietly edited. Both answers lose what somebody wrote;
 * this one shows it.
 *
 * The verbatim text comes from the source the parser was handed, sliced at the
 * node's own offsets, so it is what the author typed rather than something
 * rebuilt from the tree.
 */

import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { VFile } from 'vfile';

/** Block nodes an annotation draws. Every other block is handed back as text. */
const DRAWN_BLOCKS = new Set(['paragraph', 'list', 'listItem']);

/**
 * Inline nodes an annotation draws. `text` and `break` carry the words
 * themselves; the other four are the marks.
 */
const DRAWN_INLINES = new Set([
  'text',
  'break',
  'strong',
  'emphasis',
  'delete',
  'link',
]);

/** A node with the source offsets remark records on everything it parses. */
interface Positioned {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: unknown[];
}

/**
 * The characters that produced this node.
 * @param node - Any mdast node.
 * @param source - The markdown the parser was handed.
 * @returns The slice of source behind it, or an empty string when the parser
 *   recorded no offsets (a node some other plugin synthesized).
 */
function typedAs(node: Positioned, source: string): string {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  return from === undefined || to === undefined ? '' : source.slice(from, to);
}

/**
 * Rewrite one inline node, and its children, to what an annotation draws.
 * @param node - The inline node.
 * @param source - The markdown the parser was handed.
 * @returns The node itself when it is drawn, else a text node of its source.
 */
function keepInline(node: PhrasingContent, source: string): PhrasingContent {
  if (!DRAWN_INLINES.has(node.type)) {
    return { type: 'text', value: typedAs(node as Positioned, source) };
  }
  const withChildren = node as { children?: PhrasingContent[] };
  if (withChildren.children) {
    withChildren.children = withChildren.children.map((child) =>
      keepInline(child, source),
    );
  }
  return node;
}

/**
 * Rewrite one block node, and everything under it, to what an annotation
 * draws.
 * @param node - The block node.
 * @param source - The markdown the parser was handed.
 * @returns The node itself when it is drawn, else a paragraph of its source.
 */
function keepBlock(node: RootContent, source: string): RootContent {
  if (!DRAWN_BLOCKS.has(node.type)) {
    return {
      type: 'paragraph',
      children: [{ type: 'text', value: typedAs(node as Positioned, source) }],
    };
  }
  if (node.type === 'paragraph') {
    node.children = node.children.map((child) => keepInline(child, source));
    return node;
  }
  const withChildren = node as { children?: RootContent[] };
  if (withChildren.children) {
    withChildren.children = withChildren.children.map((child) =>
      keepBlock(child, source),
    );
  }
  return node;
}

/**
 * The plugin itself, for remark's `plugins` list.
 * @returns A transformer that rewrites the tree in place.
 */
export function keepUnsupportedAsTyped(): (tree: Root, file: VFile) => void {
  return (tree, file) => {
    const source = String(file.value);
    tree.children = tree.children.map((child) => keepBlock(child, source));
  };
}
