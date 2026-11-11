// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the document hands the Agent's attachment tray (inner#936): one text
 * item holding the selection or the block as Markdown, taken at the moment of
 * the click.
 *
 * Ids follow the canvas convention of naming what was picked
 * (`spaces/canvas/attach-nodes.ts`): a block is keyed by its id, so adding it
 * again replaces the item with a fresh snapshot; a selection has no identity
 * of its own and is keyed by its content, so adding the same words again
 * leaves one item.
 */

import { cleanHTMLToMarkdown, getNodeById, selectedFragmentToHTML } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import type { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import { MessageSquarePlus } from 'lucide-react';

import { t } from '@breatic/shared';

import { clipAttachmentName, hashOf } from '@web/lib/attachment-naming';
import { mediaNameOf, mediaQuoteOf } from '@web/spaces/document/document-comment-media';
import { isMediaBlockType, pendingUploadId } from '@web/spaces/document/document-media-types';
import type { ToolDef, ToolEditor } from '@web/spaces/document/document-tool-button';
import { attachToChat } from '@web/stores/attach-to-chat';
import type { TrayItem } from '@web/stores/chat-attachments';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';
import { cellsBlocks, tableClippedBlocks } from '@web/spaces/document/document-table-copy';

/**
 * The first non-empty line of some text, cut to the length a name may run.
 * @param text - The text.
 * @returns The name, or empty when the text holds no words; the tray then
 *   shows the kind of item instead.
 */
function nameFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return clipAttachmentName(line);
}

/**
 * A ready text item.
 * @param id - Its id.
 * @param name - What the tray calls it.
 * @param text - What is sent.
 * @returns The item.
 */
function textItem(id: string, name: string, text: string): TrayItem {
  return {
    id,
    name,
    type: 'text',
    status: 'ready',
    chip: { id, type: 'text', name, data_snapshot: { text } },
  };
}

/**
 * The words the selection covers, one stretch per range in document order:
 * over table cells that is the selected cells only. A cell selection lists the
 * cell the drag ended on first, so the ranges are sorted.
 * @param doc - The document.
 * @param selection - The selection.
 * @returns The words, a line per stretch.
 */
function selectedWords(doc: PMNode, selection: Selection): string {
  return [...selection.ranges]
    .sort((a, b) => a.$from.pos - b.$from.pos)
    .map((range) => doc.textBetween(range.$from.pos, range.$to.pos, '\n', '\n'))
    .join('\n');
}

/**
 * Whether a selection covers any words, which handing it to the Agent needs.
 * @param doc - The document.
 * @param selection - The selection.
 * @returns True when it does.
 */
export function selectionHasWords(doc: PMNode, selection: Selection): boolean {
  return selectedWords(doc, selection).trim() !== '';
}

/**
 * The selection as Markdown: what copy puts on the clipboard, except inside
 * one block. There BlockNote exports bare inline HTML, and its Markdown
 * conversion reads a top-level `<br>` as nothing and a top-level link as a
 * block of its own, so the words are wrapped in the paragraph they came from
 * first. A code block keeps the raw text copy gives it.
 * @param editor - The document editor.
 * @param view - Its view.
 * @returns The Markdown, without the exporter's closing newline.
 */
function selectionMarkdown(editor: ToolEditor, view: EditorView): string {
  const { $from, $to } = view.state.selection;
  const insideOneBlock =
    $from.parent.isTextblock && $from.sameParent($to) && $from.parent.type.spec.code !== true;
  if (insideOneBlock) return cleanHTMLToMarkdown(`<p>${selectedFragmentToHTML(view, editor).externalHTML}</p>`).trimEnd();
  // Selected cells, or a range through a table: the plain text copy writes,
  // where BlockNote's export empties or flattens the cells.
  const picked = tableClippedBlocks(view);
  return (picked === null ? selectedFragmentToHTML(view, editor).markdown : blocksMarkdown(editor, picked.blocks)).trimEnd();
}

/**
 * The user's selection, as an item for the tray.
 * @param editor - The document editor, mounted.
 * @returns The item.
 * @throws {Error} When the editor is not mounted.
 */
export function selectionItem(editor: ToolEditor): TrayItem {
  const view = editor.prosemirrorView;
  if (view === null) throw new Error('the document editor is not mounted');
  return selectedItem(selectionMarkdown(editor, view), selectedWords(view.state.doc, view.state.selection));
}

/**
 * Some cells, as an item for the tray: the item the user's selection gives
 * with those cells selected (inner#1239 A11).
 * @param editor - The document editor, mounted.
 * @param cells - The cells.
 * @returns The item.
 * @throws {Error} When the editor is not mounted.
 */
export function cellsItem(editor: ToolEditor, cells: CellSelection): TrayItem {
  const view = editor.prosemirrorView;
  if (view === null) throw new Error('the document editor is not mounted');
  return selectedItem(blocksMarkdown(editor, cellsBlocks(view, cells).blocks).trimEnd(), selectedWords(view.state.doc, cells));
}

/**
 * A selection's item, keyed by its content.
 * @param markdown - What is sent.
 * @param words - The words it covers, for its name.
 * @returns The item.
 */
function selectedItem(markdown: string, words: string): TrayItem {
  return textItem(`document-selection-${hashOf([markdown])}`, nameFrom(words), markdown);
}

/**
 * One block and its children, as an item for the tray.
 * @param editor - The document editor, mounted.
 * @param blockId - The block's id.
 * @returns The item.
 * @throws {Error} When the editor holds no such block.
 */
export function blockItem(editor: ToolEditor, blockId: string): TrayItem {
  const block = editor.getBlock(blockId);
  const node = getNodeById(blockId, editor.prosemirrorState.doc)?.node;
  if (block === undefined || node === undefined) {
    throw new Error(`no block ${blockId} in the document`);
  }
  const markdown = blocksMarkdown(editor, [block]);
  const words = node.textBetween(0, node.content.size, '\n', '\n');
  return textItem(`document-block-${blockId}`, nameFrom(words), markdown);
}

/**
 * A picture, video or audio block as a media attachment, the way a file the
 * user uploads into the chat goes (inner#1316 §5.5): the tray shows its name
 * cut to the tray's length, and the snapshot carries the block's whole name
 * and caption beside its address, each only when set.
 * @param editor - The document editor.
 * @param blockId - The media block.
 * @returns The tray item.
 * @throws {Error} When the document holds no media block with that id.
 */
export function mediaItem(editor: ToolEditor, blockId: string): TrayItem {
  const media = mediaQuoteOf(editor.prosemirrorState.doc, blockId);
  if (media === null) throw new Error(`no media block ${blockId} in the document`);
  const id = `document-media-${blockId}`;
  const name = nameFrom(mediaNameOf(media, t));
  const snapshot = {
    url: media.url,
    ...(media.name === '' ? {} : { name: media.name }),
    ...(media.caption === '' ? {} : { caption: media.caption }),
  };
  return { id, name, type: media.type, status: 'ready', chip: { id, type: media.type, name, data_snapshot: snapshot } };
}

/**
 * Whether a block group holds a picture, video or audio whose upload finished.
 * @param group - The rows nested under a block, or null when there are none.
 * @returns True when it does.
 */
function holdsUploadedMedia(group: PMNode | null): boolean {
  let found = false;
  group?.descendants((node) => {
    found ||= isMediaBlockType(node.type.name) && pendingUploadId(node.attrs) === null;
    return !found;
  });
  return found;
}

/**
 * What the handle menu hands over for a media row: the media, and the rows
 * nested under it as text, the way it hands any row over with its children.
 * @param editor - The document editor.
 * @param blockId - The media block.
 * @returns The media item, then a text item when rows are nested under it.
 * @throws {Error} When the document holds no media block with that id.
 */
export function mediaRowItems(editor: ToolEditor, blockId: string): TrayItem[] {
  const media = mediaItem(editor, blockId);
  // `mediaItem` has found the block. The media holds no words, so the row's
  // words are those of the rows nested under it.
  const { node } = getNodeById(blockId, editor.prosemirrorState.doc)!;
  const words = node.textBetween(0, node.content.size, '\n', '\n');
  // Nested rows hand something only when they hold words or uploaded media,
  // the rule that greys Add to Agent on a text row with no words.
  if (words.trim() === '' && !holdsUploadedMedia(node.childCount > 1 ? node.child(1) : null)) return [media];
  // The editor is typed without its schema, so its blocks read as `never`.
  const { children } = editor.getBlock(blockId)! as { readonly children: readonly { readonly id: string }[] };
  const markdown = blocksMarkdown(editor, children as never).trimEnd();
  return [media, textItem(`document-block-${blockId}`, nameFrom(words), markdown)];
}

/** The bubble bar's entry, handing the user's selection to the Agent. */
export const addToAgentTool: ToolDef = {
  id: 'addToAgent',
  labelKey: 'canvas.contextMenu.addToAgent',
  Icon: MessageSquarePlus,
  needsProject: true,

  /**
   * Whether the selection holds any words. Read off the text only, so the
   * Markdown export runs on the click and never on a selection change.
   * @param editor - The editor.
   * @returns True when there is something to hand over.
   */
  canRun: (editor: ToolEditor): boolean => {
    const view = editor.prosemirrorView;
    return view !== null && selectionHasWords(view.state.doc, view.state.selection);
  },

  /**
   * Never pressed: it hands something over, it is not a state.
   * @returns False.
   */
  isActive: (): boolean => false,

  /**
   * Hands the selection, as it is now, to the project's Agent.
   * @param editor - The editor.
   * @param projectId - The project the document is in.
   */
  run: (editor: ToolEditor, projectId?: string | null): void => {
    if (projectId == null) return;
    void attachToChat(projectId, [selectionItem(editor)]);
  },
};
