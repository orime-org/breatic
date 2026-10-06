// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat draft is one string — lines joined by `\n`, each reference written
 * as its marker — and the box shows it as paragraphs with reference blocks.
 * These two turn one into the other.
 */

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { attachmentMarker, messageLength, messageSegments } from '@breatic/shared';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { CHAT_REFERENCE_LABEL_ATTR, chatReferenceContent } from '@web/pages/project/chat/chat-reference';
import type { TrayItem } from '@web/stores/chat-attachments';

/**
 * The box's content for a draft. Blocks come without names; the box's rules
 * give each one its attachment's name.
 * @param draft - The draft string.
 * @returns The document as TipTap JSON.
 */
export function draftContent(draft: string): JSONContent {
  return {
    type: 'doc',
    content: draft.split('\n').map((line): JSONContent => {
      const content = messageSegments(line).map((segment): JSONContent =>
        segment.kind === 'text'
          ? { type: 'text', text: segment.text }
          : chatReferenceContent(segment.id),
      );
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
    }),
  };
}

/**
 * The draft string a box's document stands for.
 * @param doc - The box's document.
 * @returns The draft.
 */
export function draftOf(doc: PMNode): string {
  const lines: string[] = [];
  doc.forEach((paragraph) => {
    let line = '';
    paragraph.forEach((child) => {
      if (child.isText) line += child.text ?? '';
      else if (child.type.name === REFERENCE_MENTION_NODE) {
        line += attachmentMarker(String(child.attrs[MENTION_SOURCE_ID_ATTR] ?? ''));
      }
    });
    lines.push(line);
  });
  return lines.join('\n');
}

/**
 * How long the draft in a document is, a reference counting as one.
 * @param doc - The box's document.
 * @param attached - What is attached; only their ids are read.
 * @returns The length the reader sees.
 */
export function draftLength(doc: PMNode, attached: ReadonlyArray<{ readonly id: string }>): number {
  return messageLength(attached, draftOf(doc));
}

/**
 * Brings every block in line with what is attached: a block whose attachment
 * left goes, on its own (the spaces around it are the reader's words), and
 * the rest show their attachment's name as it reads now.
 * @param state - The box's state.
 * @param attached - What is attached.
 * @param labelOf - The name an attachment shows.
 * @returns The transaction that does it, or null when every block is in line.
 */
export function followAttachments(
  state: EditorState,
  attached: ReadonlyArray<TrayItem>,
  labelOf: (item: TrayItem) => string,
): Transaction | null {
  const byId = new Map(attached.map((item) => [item.id, item]));
  const tr = state.tr;
  const stale: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== REFERENCE_MENTION_NODE) return;
    const item = byId.get(String(node.attrs[MENTION_SOURCE_ID_ATTR]));
    if (!item) stale.push(pos);
    else {
      const label = labelOf(item);
      if (node.attrs[CHAT_REFERENCE_LABEL_ATTR] !== label) tr.setNodeAttribute(pos, CHAT_REFERENCE_LABEL_ATTR, label);
    }
  });
  // Last first, so each deletion leaves the earlier positions where they were.
  for (const pos of stale.reverse()) tr.delete(pos, pos + 1);
  return tr.docChanged ? tr : null;
}
