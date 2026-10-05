// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { writeReferences, type ChatAttachedChip } from '@breatic/shared';

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
  return writeReferences(attachments ?? [], content, (chip) => attachmentLabel(t, chip));
}
