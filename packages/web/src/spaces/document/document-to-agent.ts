// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the document hands the Agent's attachment tray (inner#936): one text
 * item holding the Markdown that copy would put on the clipboard, taken at the
 * moment of the click.
 *
 * Ids follow the canvas convention of naming what was picked
 * (`spaces/canvas/attach-nodes.ts`): a block is keyed by its id, so adding it
 * again replaces the item with a fresh snapshot; a selection has no identity
 * of its own and is keyed by its content, so adding the same words again
 * leaves one item.
 */

import { selectedFragmentToHTML } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
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
 * The reader's selection, as an item for the tray.
 * @param editor - The document editor, mounted.
 * @returns The item.
 * @throws {Error} When the editor is not mounted.
 */
export function selectionItem(editor: ToolEditor): TrayItem {
  const view = editor.prosemirrorView;
  if (view === null) throw new Error('the document editor is not mounted');
  // The trailing newline the exporter ends with says nothing to the agent.
  const markdown = selectedFragmentToHTML(view, editor).markdown.trimEnd();
  const { doc, selection } = view.state;
  // One stretch per range: over table cells that is the selected cells only.
  const words = selection.ranges
    .map((range) => doc.textBetween(range.$from.pos, range.$to.pos, '\n', '\n'))
    .join('\n');
  return textItem(`document-selection-${hashOf([markdown])}`, nameFrom(words), markdown);
}

/**
 * The ProseMirror node of one block, children and cells included.
 * @param doc - The document.
 * @param blockId - The block's id.
 * @returns The node, or undefined when no block has that id.
 */
function blockNode(doc: PMNode, blockId: string): PMNode | undefined {
  let found: PMNode | undefined;
  doc.descendants((node) => {
    if (found !== undefined) return false;
    if (node.type.name === 'blockContainer' && node.attrs.id === blockId) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * One block and its children, as an item for the tray.
 * @param editor - The document editor, mounted.
 * @param blockId - The block's id.
 * @returns The item.
 * @throws {Error} When the editor is not mounted or holds no such block.
 */
export function blockItem(editor: ToolEditor, blockId: string): TrayItem {
  const view = editor.prosemirrorView;
  const block = editor.getBlock(blockId);
  const node = view === null ? undefined : blockNode(view.state.doc, blockId);
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
    if (view === null) return false;
    const { doc, selection } = view.state;
    return selection.ranges.some(
      (range) => doc.textBetween(range.$from.pos, range.$to.pos, '\n', '\n').trim() !== '',
    );
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
    if (projectId == null || editor.prosemirrorView === null) return;
    void attachToChat(projectId, [selectionItem(editor)]);
  },
};
