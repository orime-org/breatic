// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas text pasted into the chat box: copied canvas nodes, or a picture
 * copied from an agent reply. It becomes an attachment, never the raw text.
 *
 * Copied nodes become the card "Add to Agent" makes on the same nodes
 * (inner#1349, design 5.7): read from the open canvas when every picked node
 * is on it, otherwise from a throwaway document written from the clipboard.
 */

import { CANVAS_NODES_KEY, type ChatAttachedChip } from '@breatic/shared';
import * as Y from 'yjs';

import { writeSnapshotNodes, type SnapshotNode } from '@web/data/yjs/canvas-space';
import { hashOf } from '@web/lib/attachment-naming';
import type { ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import type { TrayItem } from '@web/stores/chat-attachments';

/** What a paste of canvas text comes to. */
export type PastedCanvas =
  /** Nodes to hand over the way "Add to Agent" does, from this document. */
  | { kind: 'nodes'; doc: Y.Doc; ids: string[] }
  /** A picture copied from a reply: an image attachment. */
  | { kind: 'item'; item: TrayItem };

/**
 * What a paste of canvas nodes becomes in the chat.
 * @param payload - The parsed clipboard payload.
 * @param canvasDoc - The open canvas document, when the open Space is one.
 * @returns The outcome, or null when the payload holds nothing.
 */
export function pastedCanvas(payload: ClipboardPayload, canvasDoc: Y.Doc | undefined): PastedCanvas | null {
  const lone = payload.nodes.length === 1 ? payload.nodes[0] : undefined;
  const url = lone?.data.content;
  if (lone?.external === true && lone.type === 'image' && typeof url === 'string') {
    const id = `image-${hashOf([url])}`;
    const name = typeof lone.data.name === 'string' ? lone.data.name : '';
    const chip: ChatAttachedChip = { id, type: 'image', name, data_snapshot: { url } };
    return { kind: 'item', item: { id, name, type: 'image', status: 'ready', chip } };
  }
  const ids = payload.picked;
  if (ids.length === 0 || payload.nodes.length === 0) return null;
  const nodes = canvasDoc?.getMap(CANVAS_NODES_KEY);
  if (canvasDoc !== undefined && ids.every((id) => nodes?.has(id) === true)) return { kind: 'nodes', doc: canvasDoc, ids };
  return { kind: 'nodes', doc: docOf(payload), ids };
}

/**
 * A throwaway document holding the payload's nodes and edges. A member whose
 * group came along sits relative to it, as on the canvas; a member whose
 * group stayed behind keeps its canvas position, and its `parentId` names a
 * group the document does not have, which readers treat as top level.
 * @param payload - The parsed clipboard payload.
 * @returns The document.
 */
function docOf(payload: ClipboardPayload): Y.Doc {
  const byId = new Map(payload.nodes.map((n) => [n.id, n]));
  const nodes: SnapshotNode[] = payload.nodes.map((n) => {
    const group = n.parentId === undefined ? undefined : byId.get(n.parentId);
    const position = group ? { x: n.position.x - group.position.x, y: n.position.y - group.position.y } : n.position;
    return { id: n.id, type: n.type, position, ...(n.parentId === undefined ? {} : { parentId: n.parentId }), data: n.data };
  });
  // Groups before their members, as `writeSnapshotNodes` expects.
  nodes.sort((a, b) => Number(a.type !== 'group') - Number(b.type !== 'group'));
  const doc = new Y.Doc();
  writeSnapshotNodes(
    doc,
    nodes,
    payload.edges.map((e) => ({ ...e, createdAt: e.createdAt ?? 0 })),
  );
  return doc;
}
