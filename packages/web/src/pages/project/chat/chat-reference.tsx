// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A reference to an attachment, as a block in the chat box: the attachment's
 * name in a small chip, picked from the list `@` opens. It carries the
 * attachment id, which is what is sent; the name is written by the box's
 * rules, from what is attached and the language on screen.
 *
 * Named like the generate panel's chip so the shared caret and whitespace
 * plugins treat it as one; the chat box has its own schema, so the two never
 * meet.
 */

import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import * as React from 'react';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import { createReferenceMentionCaret } from '@web/features/reference-mention/reference-mention-caret';
import { createLocalUserInputTracker } from '@web/features/reference-mention/reference-mention-local-input';
import { createReferenceMentionRangeHighlight } from '@web/features/reference-mention/reference-mention-range-decoration';
import { AttachmentHover, AttachmentKindIcon } from '@web/pages/project/chat/AttachmentChip';
import { NO_ATTACHMENTS, type TrayItem } from '@web/stores/chat-attachments';

/** How a reference block looks, in the box and in a sent message alike. */
export const REFERENCE_BLOCK_CLASS =
  'reference-mention inline-flex h-[18px] max-w-[10rem] select-none items-center gap-1 overflow-hidden rounded-content-xs border border-border bg-chip px-1.5 align-[-1.25px] text-xs text-foreground';

/** Attr key carrying the attachment's name as the block shows it. */
export const CHAT_REFERENCE_LABEL_ATTR = 'label';

/**
 * What is attached, for the blocks to draw: each block shows its attachment's
 * kind and previews what it holds now, redrawn whenever the tray changes.
 */
export const ChatAttachmentsContext = React.createContext<ReadonlyArray<TrayItem>>(NO_ATTACHMENTS);

/** Options for {@link ChatReference}. */
export interface ChatReferenceOptions {
  /**
   * Whether an attachment id is attached. A pasted block for anything else —
   * the generate panel's chips share this markup — is read as plain words.
   */
  isAttached: (id: string) => boolean;
}

/**
 * The content a reference block is inserted as.
 * @param id - The attachment it points at.
 * @returns The block's content.
 */
export function chatReferenceContent(id: string): { type: string; attrs: Record<string, unknown> } {
  return { type: REFERENCE_MENTION_NODE, attrs: { [MENTION_SOURCE_ID_ATTR]: id } };
}

export const ChatReference = Node.create<ChatReferenceOptions>({
  name: REFERENCE_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    // Configured by the box; until then a pasted block is read as words.
    return { isAttached: () => false };
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
        parseHTML: () => '',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-reference-mention]',
        getAttrs: (el) => (this.options.isAttached(el.getAttribute('data-source-id') ?? '') ? null : false),
      },
    ];
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

  addNodeView() {
    return ReactNodeViewRenderer(ChatReferenceBlock);
  },

  renderText({ node }) {
    return String(node.attrs[CHAT_REFERENCE_LABEL_ATTR] ?? '');
  },

  addProseMirrorPlugins() {
    return [
      createReferenceMentionCaret(),
      createLocalUserInputTracker(),
      createReferenceMentionRangeHighlight(),
    ];
  },
});

/**
 * A block as the box draws it: the kind's icon and the name, previewing the
 * attachment on hover the way its card above the box does. The whole block is
 * its own drag handle, as the generate panel's chip is.
 * @param root0 - NodeView props from TipTap.
 * @param root0.node - The block.
 * @returns The block.
 */
function ChatReferenceBlock({ node }: NodeViewProps): React.JSX.Element {
  const id = String(node.attrs[MENTION_SOURCE_ID_ATTR] ?? '');
  const label = String(node.attrs[CHAT_REFERENCE_LABEL_ATTR] ?? '');
  const item = React.useContext(ChatAttachmentsContext).find((a) => a.id === id);
  return (
    <AttachmentHover chip={item?.chip} name={label}>
      <NodeViewWrapper
        as='span'
        data-reference-mention=''
        data-source-id={id}
        data-testid='chat-reference'
        data-drag-handle=''
        contentEditable={false}
        className={REFERENCE_BLOCK_CLASS}
      >
        {item ? <AttachmentKindIcon type={item.type} /> : null}
        <span className='truncate'>{label}</span>
      </NodeViewWrapper>
    </AttachmentHover>
  );
}
