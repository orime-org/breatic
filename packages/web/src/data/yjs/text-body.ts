// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Plain text in and out of a text node's shared body (#1774, design 9.2).
 *
 * The body is a `Y.XmlFragment` the editor binds to, but three write paths
 * arrive with a plain string — a dropped file's extracted text, a paste, and a
 * copied node — and three read paths need one back: the display state, the `@`
 * reference a generation prompt substitutes, and the clipboard.
 *
 * Both directions are built from Yjs's own element and text types rather than
 * routed through ProseMirror. The two conversion helpers y-tiptap offers both
 * take a ProseMirror `Schema`, and a schema belongs to the editor's extension
 * list, which lives above this layer; a data-layer module cannot reach it, and
 * threading one through every caller would put a second copy of the extension
 * list in the codebase. The structure produced here is the same one the editor
 * writes — a fragment of `paragraph` elements holding text — and the tests
 * assert exactly that, including round-tripping content the editor itself
 * produced.
 *
 * Two shapes are load-bearing and easy to get wrong:
 *
 * - A blank line is a paragraph with NO children. A paragraph holding an empty
 *   text node is rejected by ProseMirror's schema, which the editor binds with,
 *   so writing one would throw the moment somebody opened the node.
 * - Reading joins blocks with a newline. The blocks carry no separator of their
 *   own, so anything that concatenates their text (a ProseMirror node's
 *   `textContent`, for one) silently welds every line together.
 */

import * as Y from 'yjs';

/** The block element a line of plain text becomes. */
const BLOCK = 'paragraph';

/**
 * Read one block's text, concatenating the text nodes it is split across.
 *
 * A paragraph the user typed into is frequently more than one text node, since
 * Yjs splits them wherever concurrent edits met, so the pieces are joined with
 * nothing between them. Nested elements are descended into rather than skipped:
 * the text-node editor registers no such node today, but skipping them would
 * make this silently lose content the day one is added.
 * @param block - A block from the body, normally a `paragraph`.
 * @returns The block's text, without any markup.
 */
function blockText(block: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (block instanceof Y.XmlText) return block.toJSON();
  if (block instanceof Y.XmlElement) {
    return block
      .toArray()
      .map((child) => blockText(child))
      .join('');
  }
  return '';
}

/**
 * Read a body out as plain text, one line per block.
 * @param body - The body fragment to read.
 * @returns The body's text, blocks separated by a newline; the empty string for
 *   an empty fragment.
 */
export function bodyToPlainText(body: Y.XmlFragment): string {
  return body
    .toArray()
    .map((block) => blockText(block))
    .join('\n');
}

/**
 * Build the blocks a piece of plain text becomes.
 *
 * Splitting on the newline means the empty string yields one empty block, which
 * is what the body invariant asks for: a body always holds at least one block.
 * @param text - The plain text to lay out.
 * @returns One block per line.
 */
function blocksFor(text: string): Y.XmlElement[] {
  return text.split('\n').map((line) => {
    const block = new Y.XmlElement(BLOCK);
    // A blank line is a block with no children. Giving it an empty text node
    // instead would violate the schema the editor binds with.
    if (line.length > 0) block.insert(0, [new Y.XmlText(line)]);
    return block;
  });
}

/**
 * Write plain text into a body, replacing whatever was there.
 *
 * Replacement, not append: two people dropping different files on one node have
 * to end up with one whole file rather than the two spliced together. Clearing
 * and inserting happen in a single transaction so no observer ever sees the
 * body empty, and so the pair is one entry for whoever is tracking origins.
 * @param body - The body fragment to write into.
 * @param text - The plain text to write.
 */
export function writePlainTextIntoBody(body: Y.XmlFragment, text: string): void {
  const blocks = blocksFor(text);
  /**
   * Swap the body's whole content for the new blocks.
   */
  const replace = (): void => {
    if (body.length > 0) body.delete(0, body.length);
    body.insert(0, blocks);
  };
  // A detached fragment (one not yet inserted into a document) has no doc to
  // transact on. It still has to be writable: every creation path builds the
  // body before attaching it.
  if (body.doc) body.doc.transact(replace);
  else replace();
}

/**
 * Build a fresh body holding some text — the only way a body is ever created.
 *
 * The write-only counterpart of {@link writePlainTextIntoBody}, for a body that
 * does not exist yet. Every path that creates one goes through here: a paste, a
 * copied node, a dropped file, a node born empty, and the repair of a node that
 * lost its body. There is deliberately no separate "make me an empty one" —
 * the empty string yields one empty block, which IS the invariant a body has to
 * satisfy, so a second function would be this one with `''` written out longhand
 * and would drift the day the shape of an empty block changes.
 *
 * It writes without reading, and that matters: a fragment that has not been
 * attached to a document yet cannot be read from — Yjs answers such reads with a
 * warning and preliminary content it cannot see — and a node's data map is
 * populated before it is attached. Whether a body already exists is the caller's
 * question, and both callers already answer it by looking at the node's `body`
 * key; answering it again in here would be a second, weaker guard on the same
 * fact.
 *
 * A document Space's body holds the same invariant, established the same way:
 * by the one writer that runs exactly once. There that writer is the backend
 * creating the Space (`@breatic/shared`'s `document-body`, worth reading for
 * why a client-side emptiness check cannot converge); here it is node
 * creation.
 * @param text - The plain text the new body should hold. The empty string gives
 *   the single empty block a body must never be without: the editor's schema
 *   wants at least one, and a body that disagrees loses the redo stack the first
 *   time an undo empties it.
 * @returns A fragment holding one block per line.
 */
export function bodyFromText(text: string): Y.XmlFragment {
  const body = new Y.XmlFragment();
  body.insert(0, blocksFor(text));
  return body;
}
