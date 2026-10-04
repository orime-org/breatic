// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { attachmentMarker, messageSegments, type ChatAttachedChip } from '@breatic/shared';

import type { useTranslation } from '@web/i18n/use-translation';

/** The translator a component gets from `useTranslation`. */
type Translate = ReturnType<typeof useTranslation>;

/** What an attachment is called on screen needs to know about it. */
interface Labelled {
  name: string;
  type: ChatAttachedChip['type'];
  /** A tray item's chip, once it has one. */
  chip?: ChatAttachedChip | undefined;
  /** A sent attachment's own snapshot. */
  data_snapshot?: ChatAttachedChip['data_snapshot'];
}

/**
 * What an attachment is called wherever the chat shows it: its name; for an
 * unnamed piece of the canvas, how many nodes it holds; otherwise its kind.
 * @param t - The translator.
 * @param item - The attachment: a tray item or a sent chip.
 * @returns The label.
 */
export function attachmentLabel(t: Translate, item: Labelled): string {
  if (item.name) return item.name;
  if (item.type === 'canvas') {
    const nodes = (item.data_snapshot ?? item.chip?.data_snapshot)?.nodes;
    return t('chat.attachment.nodes', { count: Array.isArray(nodes) ? nodes.length : 0 });
  }
  return t('chat.attachment.kind', { kind: item.type });
}

/** One run of a sent message: plain text, or a reference matched to its attachment. */
export type ResolvedSegment =
  | { kind: 'text'; text: string }
  | { kind: 'reference'; chip: ChatAttachedChip }
  | { kind: 'unattached'; marker: string };

/**
 * A sent message split around its references, each matched to the attachment
 * it points at; a marker for anything the message did not carry stays the
 * text it is.
 * @param content - What the reader typed.
 * @param attachments - What the message carried.
 * @returns The runs.
 */
export function resolvedSegments(
  content: string,
  attachments: readonly ChatAttachedChip[] | undefined,
): ResolvedSegment[] {
  const byId = new Map((attachments ?? []).map((chip) => [chip.id, chip]));
  return messageSegments(content).map((segment): ResolvedSegment => {
    if (segment.kind === 'text') return segment;
    const chip = byId.get(segment.id);
    return chip ? { kind: 'reference', chip } : { kind: 'unattached', marker: attachmentMarker(segment.id) };
  });
}

/**
 * Typed words as plain text, each reference read as its attachment's label.
 * @param t - The translator.
 * @param content - What the reader typed.
 * @param attachments - What the message carried.
 * @returns The words.
 */
export function wordsWithLabels(
  t: Translate,
  content: string,
  attachments: readonly ChatAttachedChip[] | undefined,
): string {
  return resolvedSegments(content, attachments)
    .map((s) => (s.kind === 'text' ? s.text : s.kind === 'reference' ? attachmentLabel(t, s.chip) : s.marker))
    .join('');
}
