// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas text pasted into the chat box: copied canvas nodes, or a picture
 * copied from an agent reply. It becomes an attachment, never the raw text.
 */

import type { ChatAttachedChip } from '@breatic/shared';
import { readNodeMedia } from '@breatic/shared';

import { hashOf } from '@web/lib/attachment-naming';
import { nodeNameOf, pickId } from '@web/spaces/canvas/attach-nodes';
import type { ClipboardNode } from '@web/spaces/canvas/node-clipboard';
import type { TrayItem } from '@web/stores/chat-attachments';

/** What a paste of canvas text comes to. */
export type PastedCanvas =
  /** Nodes the open canvas has: hand them over the way "Add to Agent" does. */
  | { kind: 'onCanvas'; ids: string[] }
  /** Anything else: an attachment built from what the clipboard carries. */
  | { kind: 'item'; item: TrayItem };

/**
 * What a paste of canvas nodes becomes in the chat.
 * @param nodes - The parsed clipboard nodes.
 * @param onCanvas - Whether the open canvas has a node with this id.
 * @returns The outcome, or null when the payload holds nothing.
 */
export function pastedCanvas(nodes: readonly ClipboardNode[], onCanvas: (id: string) => boolean): PastedCanvas | null {
  const lone = nodes.length === 1 ? nodes[0] : undefined;
  if (lone?.external === true && lone.type === 'image' && typeof lone.content === 'string') {
    const id = `image-${hashOf([lone.content])}`;
    const name = lone.name ?? '';
    const chip: ChatAttachedChip = { id, type: 'image', name, data_snapshot: { url: lone.content } };
    return { kind: 'item', item: { id, name, type: 'image', status: 'ready', chip } };
  }
  // A group copies with its members; handing over the group alone is what
  // "Add to Agent" does with it, and what names the pick after the group.
  const inPayload = new Set(nodes.flatMap((n) => (n.id === undefined ? [] : [n.id])));
  const top = nodes.filter((n) => n.parentId === undefined || !inPayload.has(n.parentId));
  if (top.length === 0) return null;
  const ids = top.flatMap((n) => (n.id === undefined ? [] : [n.id]));
  if (ids.length === top.length && ids.every(onCanvas)) return { kind: 'onCanvas', ids };
  const id = pickId(nodes.map((n) => n.id ?? JSON.stringify(n)));
  const entries = nodes.map(entryOf);
  const lead = top.length === 1 ? top[0] : undefined;
  const name = lead ? nodeNameOf(entryOf(lead).data) : '';
  const chip: ChatAttachedChip = { id, type: 'canvas', name, data_snapshot: { nodes: entries, edges: [] } };
  return { kind: 'item', item: { id, name, type: 'canvas', status: 'ready', chip } };
}

/**
 * One clipboard node in the shape "Add to Agent" hands a node over in, so the
 * card previews it and the model reads it the same way.
 * @param node - The clipboard node.
 * @returns Its snapshot entry.
 */
function entryOf(node: ClipboardNode): { data: Record<string, unknown> } & Record<string, unknown> {
  // A text node's words are its body; the media kinds keep their asset as content.
  const words = node.content === undefined ? {} : node.type === 'text' ? { body: node.content } : { content: node.content };
  return {
    ...(node.id === undefined ? {} : { id: node.id }),
    type: node.type,
    position: node.position,
    ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
    data: {
      kind: node.type,
      ...(node.name === undefined ? {} : { name: node.name }),
      ...words,
      ...(node.media === undefined ? {} : readNodeMedia(node.media as Record<string, unknown>)),
    },
  };
}
