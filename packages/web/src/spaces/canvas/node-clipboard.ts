// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Canvas clipboard pure functions (slice 2b).
 *
 * The system clipboard is the single source of truth: copying nodes writes a
 * marker-tagged JSON payload via `navigator.clipboard.writeText`, and the
 * canvas `paste` handler reads it back — distinguishing "paste nodes" from
 * "paste plain text" by the marker. These helpers stay DOM/ReactFlow-free so
 * the serialize / parse / clone logic is unit-testable in isolation.
 */

import type { CanvasNodeFields } from '@breatic/shared';

import {
  createEmptyNode,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';

/**
 * Marker prefix tagging clipboard text as serialized breatic canvas nodes.
 * Plain pasted text never starts with this, so the paste handler can branch
 * on it without ambiguity.
 */
export const CLIPBOARD_MARKER = '__breatic_canvas_nodes__:';

/**
 * The portable subset of a node carried through the system clipboard — only
 * what's needed to re-create it elsewhere (ids / metadata are minted fresh on
 * paste). Restricted to creatable content modalities (annotation / group are
 * not copied in this slice).
 */
export interface ClipboardNode {
  /** Content modality (text / image / audio / video). */
  type: CreatableNodeType;
  /** Original canvas position (offset is applied on paste). */
  position: { x: number; y: number };
  /** Display name, when the source node had one. */
  name?: string;
  /** Content payload (text body / asset url), when present. */
  content?: string;
}

/**
 * Serialize selected nodes to a marker-tagged JSON string for the system
 * clipboard.
 * @param nodes - The clipboard-portable node subsets to serialize.
 * @returns `CLIPBOARD_MARKER` followed by the JSON-encoded node array.
 */
export function serializeNodes(nodes: ReadonlyArray<ClipboardNode>): string {
  return CLIPBOARD_MARKER + JSON.stringify(nodes);
}

/**
 * Parse clipboard text back into clipboard nodes — only when it's our marked,
 * well-formed node payload.
 * @param text - Raw clipboard text.
 * @returns The parsed node array, or `null` when the text is plain (no marker)
 *   or malformed (non-JSON / non-array after the marker).
 */
export function parseClipboardNodes(text: string): ClipboardNode[] | null {
  if (!text.startsWith(CLIPBOARD_MARKER)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(CLIPBOARD_MARKER.length));
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  return parsed as ClipboardNode[];
}

/**
 * Clone clipboard nodes into fresh wire nodes: new unique ids, positions
 * shifted by `offset` (so relative layout is preserved across a multi-node
 * paste), carried name / content, and fresh metadata (createdBy / createdAt /
 * idle state). Reuses {@link createEmptyNode} so the wire shape stays in one
 * place.
 * @param nodes - The clipboard nodes to clone.
 * @param createdBy - User id minted onto every clone (caller injects from store).
 * @param offset - Per-axis shift applied to each node's position.
 * @param offset.dx - X shift.
 * @param offset.dy - Y shift.
 * @returns Fresh {@link CanvasNodeFields} ready to hand to `addNode`.
 */
export function cloneForPaste(
  nodes: ReadonlyArray<ClipboardNode>,
  createdBy: string,
  offset: { dx: number; dy: number },
): CanvasNodeFields[] {
  return nodes.map((node) => {
    const fresh = createEmptyNode(
      node.type,
      { x: node.position.x + offset.dx, y: node.position.y + offset.dy },
      createdBy,
    );
    return {
      ...fresh,
      data: {
        ...fresh.data,
        ...(node.name !== undefined ? { name: node.name } : {}),
        ...(node.content !== undefined ? { content: node.content } : {}),
      },
    };
  });
}

/**
 * Build a fresh text node carrying pasted plain text, with empty-node defaults
 * otherwise. Reuses {@link createEmptyNode} so the wire shape stays in one place.
 * @param text - The pasted plain text, stored as the node's content.
 * @param position - Canvas position to place the node at.
 * @param position.x - X coordinate.
 * @param position.y - Y coordinate.
 * @param createdBy - User id of the creator (caller injects from store).
 * @returns A complete {@link CanvasNodeFields} text node.
 */
export function textToNode(
  text: string,
  position: { x: number; y: number },
  createdBy: string,
): CanvasNodeFields {
  const node = createEmptyNode('text', position, createdBy);
  return { ...node, data: { ...node.data, content: text } };
}
