// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The chat draft is one string — lines joined by `\n`, each reference written
 * as its marker — and the box shows it as paragraphs with reference blocks.
 * These two turn one into the other.
 */

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { attachmentMarker, messageLength, messageSegments } from '@breatic/shared';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { chatReferenceContent } from '@web/pages/project/chat/chat-reference';

/**
 * The box's content for a draft.
 * @param draft - The draft string.
 * @param nameOf - The name a referenced attachment shows.
 * @returns The document as TipTap JSON.
 */
export function draftContent(draft: string, nameOf: (id: string) => string): JSONContent {
  return {
    type: 'doc',
    content: draft.split('\n').map((line): JSONContent => {
      const content = messageSegments(line).map((segment): JSONContent =>
        segment.kind === 'text'
          ? { type: 'text', text: segment.text }
          : chatReferenceContent(segment.id, nameOf(segment.id)),
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
 * Where the blocks are whose attachment is not attached. A block goes on its
 * own: the spaces around it are the reader's words.
 * @param doc - The box's document.
 * @param attached - What is attached; only their ids are read.
 * @returns Their positions, last first, so each can be deleted in turn.
 */
export function stalePositions(doc: PMNode, attached: ReadonlyArray<{ readonly id: string }>): number[] {
  const ids = new Set(attached.map((a) => a.id));
  const stale: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === REFERENCE_MENTION_NODE && !ids.has(String(node.attrs[MENTION_SOURCE_ID_ATTR]))) {
      stale.push(pos);
    }
  });
  return stale.reverse();
}
