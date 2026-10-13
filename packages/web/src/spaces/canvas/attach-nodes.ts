// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isGenerationNodeType, writtenMark, type ChatAttachedChip, type ModelCatalog } from '@breatic/shared';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import * as Y from 'yjs';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import { ATTACHMENT_NAME_CHARS, hashOf } from '@web/lib/attachment-naming';
import type { ContentNodeView } from '@web/data/yjs/node-view';
import { toAbsolutePosition } from '@web/spaces/canvas/group-geometry';
import { currentGeneration } from '@web/spaces/canvas/generate/current-generation';
import { PROMPT_NOTE_LABEL_ATTR, PROMPT_NOTE_NODE } from '@web/features/prompt-note/prompt-note';
import { REFERENCE_MENTION_NODE } from '@web/features/reference-mention/mention-node';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
} from '@web/spaces/canvas/generate/reference-mention';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The node kinds the chat can be handed; a group comes with its members. */
const ATTACHABLE = new Set<string>(['text', 'image', 'audio', 'video', 'annotation', 'group']);

/** What the pick reads beyond the canvas view (#2218). */
export interface NodeReaders {
  /** A node's stored data map, or null for a node that is gone. */
  dataOf: (nodeId: string) => Y.Map<unknown> | null;
  /** The model catalog, to resolve what each node would run right now. */
  catalog: ModelCatalog;
  /** The first voice of a model's list, which an audio node sends when nobody picked one. */
  firstVoiceOf: (model: string) => { id: string } | null | undefined;
}

/**
 * A reference mention read as the name the reader sees on its chip, and a
 * note as its words in the form a template writes it.
 * @param element - An element inside a prompt.
 * @returns The text, or undefined for anything else.
 */
function mentionText(element: Y.XmlElement): string | undefined {
  // A note is handed over too: the agent is given everything the node holds.
  if (element.nodeName === PROMPT_NOTE_NODE) return writtenMark({ kind: 'note', label: String(element.getAttribute(PROMPT_NOTE_LABEL_ATTR) ?? '') });
  if (element.nodeName !== REFERENCE_MENTION_NODE) return undefined;
  const label = element.getAttribute(MENTION_LABEL_ATTR) ?? element.getAttribute(MENTION_KIND_ATTR);
  return `@${String(label ?? '')}`;
}

/**
 * A stored value as plain data: fragments become their words, maps objects
 * and arrays arrays, all the way down.
 * @param value - A value from a node's data map.
 * @returns Its plain form.
 */
function plain(value: unknown): unknown {
  if (value instanceof Y.XmlFragment) return bodyToPlainText(value, mentionText);
  if (value instanceof Y.Map) {
    return Object.fromEntries([...value.entries()].map(([key, inner]) => [key, plain(inner)]));
  }
  if (value instanceof Y.Array) return value.toArray().map(plain);
  return value;
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
    if (byId.get(id)?.type === 'group') {
      for (const n of nodes) if (n.parentId === id) add(n.id);
    }
  }
  return out;
}

/**
 * What a node is called on the card and in its preview.
 * @param type - The node's type.
 * @param data - The node's data, from the canvas or from a stored snapshot.
 * @param data.name - Its name, when it has one.
 * @param data.content - A note's words.
 * @returns Its name, or for a note its own words cut short, or its type.
 */
export function nodeNameOf(type: string, data: { name?: unknown; content?: unknown }): string {
  const named = typeof data.name === 'string' ? data.name.trim() : '';
  if (named) return named;
  if (type === 'annotation' && typeof data.content === 'string') {
    return data.content.trim().slice(0, ATTACHMENT_NAME_CHARS);
  }
  return type;
}

/**
 * A short, stable id for a set of node ids, whatever order they came in.
 * @param ids - The node ids.
 * @returns The same string for the same set.
 */
export function pickId(ids: readonly string[]): string {
  return `canvas-${ids.length}-${hashOf(ids)}`;
}

/** The picked nodes and the links between them, as the agent reads them. */
export type PickSnapshot = {
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: CanvasEdge[];
};

/**
 * The picked piece of the canvas as the agent reads it: the picked nodes as
 * they are -- each with where it sits, the group it is in and its data -- and
 * the links between them. The data is everything the node stores -- every
 * mode's prompt and lyrics and the video node's shots, whatever the model in
 * use takes -- with fragments as plain text, and a generating node also says
 * what it would run right now (#2218), so the agent can tell what is written
 * from what is in effect.
 * @param graph - The canvas, read fresh.
 * @param graph.nodes - Every node on it.
 * @param graph.edges - Every link on it.
 * @param picked - The ids that were picked; a group brings its members.
 * @param readers - Reads what the view does not carry.
 * @returns The snapshot, or null when nothing picked can be handed over.
 */
export function snapshotOfPick(
  graph: { nodes: readonly CanvasNodeView[]; edges: readonly CanvasEdge[] },
  picked: readonly string[],
  readers: NodeReaders,
): PickSnapshot | null {
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
    return node && ATTACHABLE.has(node.type) ? [node] : [];
  });
  if (nodes.length === 0) return null;
  const ids = new Set(nodes.map((n) => n.id));
  /**
   * One node as handed over.
   * @param node - The node.
   * @returns Its snapshot entry.
   */
  const entry = (node: CanvasNodeView): Record<string, unknown> & { id: string } => {
    const stored = readers.dataOf(node.id);
    const data = {
      ...(node.data as unknown as Record<string, unknown>),
      ...(stored ? (plain(stored) as Record<string, unknown>) : {}),
    };
    const current = isGenerationNodeType(node.type)
      ? currentGeneration(
        node.type,
          node.data as ContentNodeView,
          readers.catalog,
          readers.firstVoiceOf,
      )
      : null;
    return {
      id: node.id,
      type: node.type,
      position: canvasPosition(node),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      data,
      ...(current ? { current } : {}),
    };
  };
  return {
    nodes: nodes.map(entry),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  };
}

/**
 * The item handed to the chat when a piece of the canvas is added to the
 * agent. One press is one item, holding {@link snapshotOfPick}. Named after
 * the node or group when one was picked, and left unnamed for several, which
 * the card counts.
 * @param graph - The canvas, read fresh.
 * @param graph.nodes - Every node on it.
 * @param graph.edges - Every link on it.
 * @param picked - The ids that were picked.
 * @param readers - Reads what the view does not carry.
 * @returns The ready item, or null when nothing picked can be handed over.
 */
export function itemForPick(
  graph: { nodes: readonly CanvasNodeView[]; edges: readonly CanvasEdge[] },
  picked: readonly string[],
  readers: NodeReaders,
): TrayItem | null {
  const snapshot = snapshotOfPick(graph, picked, readers);
  if (snapshot === null) return null;
  const ids = new Set(snapshot.nodes.map((n) => n.id));
  const lead = picked.length === 1 ? graph.nodes.find((n) => n.id === picked[0]) : undefined;
  const name = lead && ids.has(lead.id) ? nodeNameOf(lead.type, lead.data) : '';
  const id = pickId([...ids]);
  const chip: ChatAttachedChip = { id, type: 'canvas', name, data_snapshot: snapshot };
  return { id, name, type: 'canvas', status: 'ready', chip };
}
