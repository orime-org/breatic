// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import type * as Y from 'yjs';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import { toAbsolutePosition } from '@web/spaces/canvas/group-geometry';
import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
} from '@web/spaces/canvas/generate/reference-mention';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The node kinds the chat can be handed; a group comes with its members. */
const ATTACHABLE = new Set<string>(['text', 'image', 'audio', 'video', 'annotation', 'group']);

/** How long a note's own words may run when they stand in for its name. */
const NOTE_NAME_CHARS = 40;

/** Reads what a node's view carries only as markup: the words in its fragments. */
export interface NodeTextReaders {
  /** Every fragment in a node's data, by the field it sits under. */
  fragmentsOf: (nodeId: string) => Record<string, Y.XmlFragment>;
}

/**
 * A reference mention read as the name the reader sees on its chip.
 * @param element - An element inside a prompt.
 * @returns `@` and the name, or undefined for anything but a mention.
 */
function mentionText(element: Y.XmlElement): string | undefined {
  if (element.nodeName !== REFERENCE_MENTION_NODE) return undefined;
  const label = element.getAttribute(MENTION_LABEL_ATTR) ?? element.getAttribute(MENTION_KIND_ATTR);
  return `@${String(label ?? '')}`;
}

/**
 * A node's fragments as plain text, by the field each sits under.
 * @param fragments - The fragments.
 * @returns Their words.
 */
function plainTexts(fragments: Record<string, Y.XmlFragment>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fragments).map(([key, fragment]) => [key, bodyToPlainText(fragment, mentionText)]),
  );
}

/**
 * The ids a pick stands for: a group brings its members along.
 * @param nodes - Every node on the canvas.
 * @param picked - The ids that were picked, in order.
 * @returns Node ids, each once, in the order they were reached.
 */
function expand(nodes: readonly CanvasNodeView[], picked: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  /**
   * Keep an id the first time it is reached.
   * @param id - The node id.
   */
  const add = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const id of picked) {
    add(id);
    if (byId.get(id)?.data.kind === 'group') {
      for (const n of nodes) if (n.parentId === id) add(n.id);
    }
  }
  return out;
}

/**
 * What a node is called on the card and in its preview.
 * @param data - The node's data, from the canvas or from a stored snapshot.
 * @param data.kind - Its kind.
 * @param data.name - Its name, when it has one.
 * @param data.content - A note's words.
 * @returns Its name, or for a note its own words cut short, or its kind.
 */
export function nodeNameOf(data: { kind?: unknown; name?: unknown; content?: unknown }): string {
  const named = typeof data.name === 'string' ? data.name.trim() : '';
  if (named) return named;
  const kind = typeof data.kind === 'string' ? data.kind : '';
  if (kind === 'annotation' && typeof data.content === 'string') {
    return data.content.trim().slice(0, NOTE_NAME_CHARS);
  }
  return kind;
}

/**
 * A short, stable id for a set of node ids, whatever order they came in.
 * @param ids - The node ids.
 * @returns The same string for the same set.
 */
function pickId(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const ch of [...ids].sort().join('\u0000')) {
    hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  }
  return `canvas-${ids.length}-${hash.toString(36)}`;
}

/**
 * The item handed to the chat when a piece of the canvas is added to the agent.
 *
 * One press is one item: the picked nodes as they are -- each with where it
 * sits, the group it is in and its data -- and the links between them. A
 * fragment's field in the view holds its XML markup, so each is replaced by
 * its words as plain text. Named after the node or group when one was picked,
 * and left unnamed for several, which the card counts.
 * @param graph - The canvas, read fresh.
 * @param graph.nodes - Every node on it.
 * @param graph.edges - Every link on it.
 * @param picked - The ids that were picked.
 * @param readers - Reads the words the view does not carry.
 * @returns The ready item, or null when nothing picked can be handed over.
 */
export function itemForPick(
  graph: { nodes: readonly CanvasNodeView[]; edges: readonly CanvasEdge[] },
  picked: readonly string[],
  readers: NodeTextReaders,
): TrayItem | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  /**
   * Where a node sits on the canvas: a member's stored position is relative
   * to its group, which need not be in the pick.
   * @param node - The node.
   * @returns Its canvas position.
   */
  const canvasPosition = (node: CanvasNodeView): { x: number; y: number } => {
    const group = node.parentId ? byId.get(node.parentId) : undefined;
    return group ? toAbsolutePosition(node.position, group.position) : node.position;
  };
  const nodes = expand(graph.nodes, picked).flatMap((id) => {
    const node = byId.get(id);
    return node && ATTACHABLE.has(node.data.kind) ? [node] : [];
  });
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((n) => n.id));
  const snapshot = {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.kind,
      position: canvasPosition(node),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      data: {
        ...(node.data as unknown as Record<string, unknown>),
        ...plainTexts(readers.fragmentsOf(node.id)),
      },
    })),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
  const lead = picked.length === 1 ? byId.get(picked[0] ?? '') : undefined;
  const name = lead && ids.has(lead.id) ? nodeNameOf(lead.data as { kind: string }) : '';
  const id = pickId(nodes.map((n) => n.id));
  const chip: ChatAttachedChip = { id, type: 'canvas', name, data_snapshot: snapshot };
  return { id, name, type: 'canvas', status: 'ready', chip };
}
