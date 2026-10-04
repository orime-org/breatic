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
  chip?: ChatAttachedChip;
}

/**
 * What an attachment is called wherever the chat shows it: its name; for an
 * unnamed piece of the canvas, how many nodes it holds; otherwise its kind.
 * @param t - The translator.
 * @param item - The attachment.
 * @returns The label.
 */
export function attachmentLabel(t: Translate, item: Labelled): string {
  if (item.name) return item.name;
  if (item.type === 'canvas') {
    const nodes = item.chip?.data_snapshot.nodes;
    return t('chat.attachment.nodes', { count: Array.isArray(nodes) ? nodes.length : 0 });
  }
  return t('chat.attachment.kind', { kind: item.type });
}

/**
 * Typed words as plain text, each reference to one of the attachments read as
 * that attachment's label; a marker for anything else stays the text it is.
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
  const byId = new Map((attachments ?? []).map((chip) => [chip.id, chip]));
  return messageSegments(content)
    .map((segment) => {
      if (segment.kind === 'text') return segment.text;
      const chip = byId.get(segment.id);
      return chip ? attachmentLabel(t, { name: chip.name, type: chip.type, chip }) : attachmentMarker(segment.id);
    })
    .join('');
}
