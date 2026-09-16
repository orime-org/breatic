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
 *
 * The tree is typed here rather than imported from `mdast`: only the three
 * fields below are read, and the package carrying those types is a transitive
 * dependency of react-markdown rather than one this app declares.
 */

/** As much of an mdast node as this plugin reads. */
interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  value?: string;
  /** Set by remark-gfm on a task-list item; absent on an ordinary one. */
  checked?: boolean | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** As much of the parsed file as this plugin reads. */
interface ParsedFile {
  value: unknown;
}

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

/**
 * The characters that produced this node.
 * @param node - Any node in the tree.
 * @param source - The markdown the parser was handed.
 * @returns The slice of source behind it, or an empty string when the parser
 *   recorded no offsets (a node some other plugin synthesized).
 */
function typedAs(node: MarkdownNode, source: string): string {
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
function keepInline(node: MarkdownNode, source: string): MarkdownNode {
  if (!DRAWN_INLINES.has(node.type)) {
    return { type: 'text', value: typedAs(node, source) };
  }
  if (node.children) {
    node.children = node.children.map((child) => keepInline(child, source));
  }
  return node;
}

/**
 * Put a task-list item's marker back in front of its words.
 *
 * A checkbox is not one of the six marks, so `[x]` goes back as the characters
 * that produced it — the same answer a heading or a fence gets. It needs its
 * own step because a list item IS drawn, so `keepBlock` hands the item through
 * and never reaches for its source; and remark-gfm has already moved the
 * marker out of the words into `checked` by the time this plugin runs.
 * Measured without it: `- [x] shipped` and `- [ ] shipped` both reached the
 * reader as the single word "shipped".
 * @param node - A list item, already rewritten.
 * @param source - The markdown the parser was handed.
 */
function restoreTaskMarker(node: MarkdownNode, source: string): void {
  if (node.checked === undefined || node.checked === null) return;
  // From the source rather than rebuilt from `checked`, so `[X]` stays as the
  // author wrote it.
  const marker = /^(?:[-*+]|\d+[.)])\s+(\[[ xX]\])/.exec(
    typedAs(node, source).trim(),
  );
  const words = node.children?.[0];
  if (!marker || !words?.children) return;
  words.children.unshift({ type: 'text', value: `${marker[1]} ` });
}

/**
 * Rewrite one block node, and everything under it, to what an annotation
 * draws.
 * @param node - The block node.
 * @param source - The markdown the parser was handed.
 * @returns The node itself when it is drawn, else a paragraph of its source.
 */
function keepBlock(node: MarkdownNode, source: string): MarkdownNode {
  if (!DRAWN_BLOCKS.has(node.type)) {
    return {
      type: 'paragraph',
      children: [{ type: 'text', value: typedAs(node, source) }],
    };
  }
  const rewrite = node.type === 'paragraph' ? keepInline : keepBlock;
  if (node.children) {
    node.children = node.children.map((child) => rewrite(child, source));
  }
  if (node.type === 'listItem') restoreTaskMarker(node, source);
  return node;
}

/**
 * The plugin itself, for remark's `remarkPlugins` list.
 * @returns A transformer that rewrites the tree in place.
 */
export function keepUnsupportedAsTyped(): (
  tree: MarkdownNode,
  file: ParsedFile,
) => void {
  return (tree, file) => {
    const source = String(file.value);
    if (tree.children) {
      tree.children = tree.children.map((child) => keepBlock(child, source));
    }
  };
}
