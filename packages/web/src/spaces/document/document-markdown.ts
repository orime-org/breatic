// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Markdown read with the document's own schema, with no document open
 * (inner#1509).
 *
 * A proposal's body is drawn on its card and written into the document, and
 * the document may not be open for the first. Each read builds a throwaway
 * editor over an empty fragment, the way every document editor is built, so
 * the blocks it returns are the ones the open document would parse and their
 * plain text is read by the same function that reads the document's own
 * blocks.
 */

import type { BlockNoteEditor } from '@blocknote/core';
import * as Y from 'yjs';
import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blockPlainText } from '@web/spaces/document/document-blocks-read';

/** A block as the parser hands it back, ready to write into a document. */
export type ParsedBlock = Awaited<ReturnType<BlockNoteEditor<never, never, never>['tryParseMarkdownToBlocks']>>[number];

/** One block of a Markdown body: what lands, and how its words read. */
export interface MarkdownBlock {
  block: ParsedBlock;
  text: string;
}

/**
 * The blocks a Markdown body parses into, each with its plain text.
 * @param markdown - The body.
 * @returns The top-level blocks, in order; none for a body holding nothing.
 */
export async function markdownBlocks(markdown: string): Promise<MarkdownBlock[]> {
  if (markdown.trim() === '') return [];
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()), extensions: [] });
  const parsed = await editor.tryParseMarkdownToBlocks(markdown);
  editor.replaceBlocks(editor.document, parsed);
  const nodes: string[] = [];
  editor.prosemirrorState.doc.firstChild?.forEach((node) => nodes.push(blockPlainText(node)));
  return parsed.map((block, i) => ({ block, text: nodes[i] ?? '' }));
}
