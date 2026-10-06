// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import type { EditorView } from '@tiptap/pm/view';
import { MessageSquarePlus } from 'lucide-react';

import { ATTACHMENT_NAME_CHARS, hashOf } from '@web/lib/attachment-naming';
import type { ToolDef, ToolEditor } from '@web/spaces/document/document-tool-button';
import { attachToChat } from '@web/stores/attach-to-chat';
import type { TrayItem } from '@web/stores/chat-attachments';

/**
 * The first non-empty line of some text, cut to the length a name may run.
 * @param text - The text.
 * @returns The name, or empty when the text holds no words; the tray then
 *   shows the kind of item instead.
 */
function nameFrom(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line.slice(0, ATTACHMENT_NAME_CHARS);
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
 * The words the selection covers, one stretch per range: over table cells
 * that is the selected cells only.
 * @param view - The editor's view.
 * @returns The words, a line per stretch.
 */
function selectedWords(view: EditorView): string {
  const { doc, selection } = view.state;
  return selection.ranges
    .map((range) => doc.textBetween(range.$from.pos, range.$to.pos, '\n', '\n'))
    .join('\n');
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
  const { externalHTML, markdown } = selectedFragmentToHTML(view, editor);
  const { $from, $to } = view.state.selection;
  const insideOneBlock = $from.sameParent($to) && $from.parent.type.spec.code !== true;
  return (insideOneBlock ? cleanHTMLToMarkdown(`<p>${externalHTML}</p>`) : markdown).trimEnd();
}

/**
 * The reader's selection, as an item for the tray.
 * @param editor - The document editor, mounted.
 * @returns The item.
 * @throws {Error} When the editor is not mounted.
 */
export function selectionItem(editor: ToolEditor): TrayItem {
  const view = editor.prosemirrorView;
  if (view === null) throw new Error('the document editor is not mounted');
  const markdown = selectionMarkdown(editor, view);
  return textItem(`document-selection-${hashOf([markdown])}`, nameFrom(selectedWords(view)), markdown);
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
  const markdown = editor.blocksToMarkdownLossy([block]).trimEnd();
  const words = node.textBetween(0, node.content.size, '\n', '\n');
  return textItem(`document-block-${blockId}`, nameFrom(words), markdown);
}

/** The bubble bar's entry, handing the reader's selection to the Agent. */
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
    return view !== null && selectedWords(view).trim() !== '';
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
