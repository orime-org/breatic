// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A reference to an attachment, as a block in the chat box: the attachment's
 * name in a small chip, picked from the list `@` opens. It carries the
 * attachment id, which is what is sent; the name is kept current by the box.
 *
 * Named like the generate panel's chip so the shared caret and whitespace
 * plugins treat it as one; the chat box has its own schema, so the two never
 * meet.
 */

import { Node } from '@tiptap/core';
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { createReferenceMentionCaret } from '@web/features/reference-mention/reference-mention-caret';
import { createLocalUserInputTracker } from '@web/features/reference-mention/reference-mention-local-input';
import { createReferenceMentionRangeHighlight } from '@web/features/reference-mention/reference-mention-range-decoration';
import type { TrayItem } from '@web/stores/chat-attachments';

/** How a reference block looks, in the box and in a sent message alike. */
export const REFERENCE_BLOCK_CLASS =
  'reference-mention inline-flex h-[18px] max-w-[10rem] select-none items-center overflow-hidden rounded-content-xs border border-border bg-muted px-1.5 align-[-1.25px] text-xs text-foreground';

/** Attr key carrying the attachment's name as the block shows it. */
export const CHAT_REFERENCE_LABEL_ATTR = 'label';

/** Options for {@link ChatReference}. */
export interface ChatReferenceOptions {
  /** The `@` list, or null for a box with no list (tests of the draft). */
  suggestion: Omit<SuggestionOptions<TrayItem>, 'editor'> | null;
}

/**
 * The content a reference block is inserted as.
 * @param id - The attachment it points at.
 * @param label - What the block shows.
 * @returns The block's content.
 */
export function chatReferenceContent(id: string, label: string): { type: string; attrs: Record<string, unknown> } {
  return {
    type: REFERENCE_MENTION_NODE,
    attrs: { [MENTION_SOURCE_ID_ATTR]: id, [CHAT_REFERENCE_LABEL_ATTR]: label },
  };
}

export const ChatReference = Node.create<ChatReferenceOptions>({
  name: REFERENCE_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { suggestion: null };
  },

  addAttributes() {
    return {
      [MENTION_SOURCE_ID_ATTR]: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-source-id'),
        renderHTML: (attrs) =>
          attrs[MENTION_SOURCE_ID_ATTR] ? { 'data-source-id': attrs[MENTION_SOURCE_ID_ATTR] as string } : {},
      },
      [CHAT_REFERENCE_LABEL_ATTR]: {
        default: '',
        parseHTML: (el) => el.textContent ?? '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-reference-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      {
        ...HTMLAttributes,
        'data-reference-mention': '',
        'data-testid': 'chat-reference',
        class: REFERENCE_BLOCK_CLASS,
      },
      ['span', { class: 'truncate' }, String(node.attrs[CHAT_REFERENCE_LABEL_ATTR] ?? '')],
    ];
  },

  addProseMirrorPlugins() {
    return [
      ...(this.options.suggestion ? [Suggestion<TrayItem>({ editor: this.editor, ...this.options.suggestion })] : []),
      createReferenceMentionCaret(),
      createLocalUserInputTracker(),
      createReferenceMentionRangeHighlight(),
    ];
  },
});
