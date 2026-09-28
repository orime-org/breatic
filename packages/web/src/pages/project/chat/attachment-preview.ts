// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';

import { nodeNameOf } from '@web/spaces/canvas/attach-nodes';

/** How many node rows a canvas card's preview lists before counting the rest. */
export const PREVIEW_ROWS = 6;

/** One node in a canvas card's preview. */
export interface PreviewRow {
  id: string;
  kind: string;
  name: string;
  /** A still to show, when the node has one. */
  thumbnail?: string;
}

/** What hovering an attached card shows. */
export type AttachmentPreview =
  | { kind: 'image' | 'audio'; src: string }
  | { kind: 'video'; src: string; poster?: string }
  | { kind: 'text'; text: string }
  | { kind: 'nodes'; rows: PreviewRow[]; more: number };

/** A node as the snapshot holds it; stored messages are checked only as records. */
interface SnapshotNode {
  id?: unknown;
  type?: unknown;
  data?: { kind?: unknown; name?: unknown; content?: unknown; body?: unknown; coverUrl?: unknown };
}

/**
 * A string field, or undefined when it is missing or empty.
 * @param value - The field.
 * @returns The string.
 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The preview one media or text node has of its own.
 * @param node - The node.
 * @returns Its preview, or null for a kind that is listed as a row.
 */
function nodePreview(node: SnapshotNode): AttachmentPreview | null {
  // A text node's words are under `body`; the media kinds keep their asset under `content`.
  const content = str(node.type === 'text' ? node.data?.body : node.data?.content);
  if (!content) return null;
  switch (node.type) {
    case 'image':
    case 'audio':
      return { kind: node.type, src: content };
    case 'video': {
      const poster = str(node.data?.coverUrl);
      return poster ? { kind: 'video', src: content, poster } : { kind: 'video', src: content };
    }
    case 'text':
      return { kind: 'text', text: content };
    default:
      return null;
  }
}

/**
 * A node as a row: its name and, for an image or a video, its still.
 * @param node - The node.
 * @param index - Its place in the list, its key when it carries no id.
 * @returns The row.
 */
function rowOf(node: SnapshotNode, index: number): PreviewRow {
  const kind = str(node.type) ?? '';
  const thumbnail =
    kind === 'image' ? str(node.data?.content) : kind === 'video' ? str(node.data?.coverUrl) : undefined;
  const row: PreviewRow = { id: str(node.id) ?? String(index), kind, name: nodeNameOf({ ...node.data, kind }) };
  return thumbnail ? { ...row, thumbnail } : row;
}

/**
 * What hovering an attached card shows: a file previews itself, one canvas
 * node previews the way its kind does, and anything else from the canvas is
 * listed node by node.
 * @param chip - What is sent for the card, once it has it.
 * @returns The preview, or null when there is nothing to show yet.
 */
export function previewOf(chip: ChatAttachedChip | undefined): AttachmentPreview | null {
  if (!chip) return null;
  const snapshot = chip.data_snapshot;
  switch (chip.type) {
    case 'image':
    case 'video':
    case 'audio': {
      const url = str(snapshot.url);
      return url ? { kind: chip.type, src: url } : null;
    }
    case 'text': {
      const text = str(snapshot.text);
      return text ? { kind: 'text', text } : null;
    }
    case 'canvas': {
      const nodes = Array.isArray(snapshot.nodes)
        ? (snapshot.nodes as unknown[]).filter((n): n is SnapshotNode => typeof n === 'object' && n !== null)
        : [];
      if (nodes.length === 0) return null;
      const own = nodes.length === 1 && nodes[0] ? nodePreview(nodes[0]) : null;
      if (own) return own;
      return {
        kind: 'nodes',
        rows: nodes.slice(0, PREVIEW_ROWS).map(rowOf),
        more: Math.max(0, nodes.length - PREVIEW_ROWS),
      };
    }
  }
}
