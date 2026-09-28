// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The node kinds the chat can be handed. */
const ATTACHABLE = new Set<string>(['text', 'image', 'audio', 'video', 'annotation']);

/** How long a note's own words may run when they stand in for its name. */
const NOTE_NAME_CHARS = 40;

/** Reads what a node's view does not carry: the words held in its fragments. */
export interface NodeTextReaders {
  /** A text node's body as plain text. */
  bodyOf: (nodeId: string) => string | undefined;
  /** A node's prompt as plain text. */
  promptOf: (nodeId: string) => string | undefined;
}

/**
 * The ids a pick stands for: a group stands for its members.
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
    if (byId.get(id)?.data.kind === 'group') {
      for (const n of nodes) if (n.parentId === id) add(n.id);
    } else {
      add(id);
    }
  }
  return out;
}

/**
 * What a node is called in the list above the box.
 * @param node - The node.
 * @returns Its name, or for a note its own words cut short.
 */
function nameOf(node: CanvasNodeView): string {
  const data = node.data as { kind: string; name?: string; content?: string };
  const named = data.name?.trim();
  if (named) return named;
  if (data.kind === 'annotation') return (data.content ?? '').trim().slice(0, NOTE_NAME_CHARS);
  return data.kind;
}

/**
 * The items handed to the chat when nodes are added to the agent.
 *
 * Each goes as a snapshot of its data taken now, with the words held in its
 * fragments added as plain text: the prompt, and a text node's body.
 * @param nodes - Every node on the canvas, read fresh.
 * @param picked - The ids that were picked.
 * @param readers - Reads the words the view does not carry.
 * @returns Ready items, in order, each node once.
 */
export function itemsForNodes(
  nodes: readonly CanvasNodeView[],
  picked: readonly string[],
  readers: NodeTextReaders,
): TrayItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return expand(nodes, picked).flatMap((id): TrayItem[] => {
    const node = byId.get(id);
    if (!node || !ATTACHABLE.has(node.data.kind)) return [];
    const type = node.data.kind as ChatAttachedChip['type'];
    const name = nameOf(node);
    const prompt = readers.promptOf(id);
    const text = type === 'text' ? readers.bodyOf(id) : undefined;
    const chip: ChatAttachedChip = {
      id,
      type,
      name,
      data_snapshot: {
        ...(node.data as unknown as Record<string, unknown>),
        ...(prompt ? { prompt } : {}),
        ...(text === undefined ? {} : { text }),
      },
    };
    return [{ id, name, type, status: 'ready', chip }];
  });
}
