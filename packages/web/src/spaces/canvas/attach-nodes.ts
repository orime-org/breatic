// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ChatAttachedChip } from '@breatic/shared';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';
import type * as Y from 'yjs';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import {
  MENTION_KIND_ATTR,
  MENTION_LABEL_ATTR,
} from '@web/spaces/canvas/generate/reference-mention';
import type { TrayItem } from '@web/stores/chat-attachments';

/** The node kinds the chat can be handed. */
const ATTACHABLE = new Set<string>(['text', 'image', 'audio', 'video', 'annotation']);

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
 * Each goes as a snapshot of its data taken now. A fragment's field in the
 * view holds its XML markup, so each is replaced by its words as plain text.
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
    const chip: ChatAttachedChip = {
      id,
      type,
      name,
      data_snapshot: {
        ...(node.data as unknown as Record<string, unknown>),
        ...plainTexts(readers.fragmentsOf(id)),
      },
    };
    return [{ id, name, type, status: 'ready', chip }];
  });
}
