// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A prompt read straight off its fragment, with no editor mounted (#2218,
 * design §5.4).
 *
 * The per-shot storyboard sends every shot's words and the union of what the
 * shots mention. Both are read at submit from the shots the node holds right
 * then, so a shot a collaborator removed a moment ago cannot linger in either
 * the way it would in a list the editors report into.
 */

import * as Y from 'yjs';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import { chipWordsReader, MENTION_KIND_ATTR } from '@web/spaces/canvas/generate/reference-mention';
import type { MentionTokens } from '@web/spaces/canvas/generate/reference-urls';

/** What the editor puts between two blocks of a prompt (`serializePromptText`'s default). */
const BLOCK_SEPARATOR = '\n\n';

/**
 * Every mention element under a node, in document order.
 * @param node - A fragment or an element.
 * @returns The mention elements.
 */
function mentionsUnder(node: Y.XmlFragment | Y.XmlElement): Y.XmlElement[] {
  return node.toArray().flatMap((child) => {
    if (!(child instanceof Y.XmlElement)) return [];
    return child.nodeName === REFERENCE_MENTION_NODE ? [child] : mentionsUnder(child);
  });
}

/**
 * The sources a prompt mentions, each once, in the order they first appear.
 * @param fragment - The prompt.
 * @returns Their node ids.
 */
export function mentionedSourceIds(fragment: Y.XmlFragment): string[] {
  const ids = mentionsUnder(fragment)
    .map((element) => element.getAttribute(MENTION_SOURCE_ID_ATTR))
    .filter((id): id is string => typeof id === 'string');
  return [...new Set(ids)];
}

/**
 * One piece of a prompt as the model reads it: text as written, a chip as
 * `chipWordsReader` reads it.
 * @param node - A piece of the prompt.
 * @param words - Reads one chip.
 * @returns Its text.
 */
function pieceText(
  node: Y.XmlElement | Y.XmlText | Y.XmlHook,
  words: ReturnType<typeof chipWordsReader>,
): string {
  if (node instanceof Y.XmlText) return node.toJSON();
  if (!(node instanceof Y.XmlElement)) return '';
  if (node.nodeName !== REFERENCE_MENTION_NODE) {
    return node.toArray().map((child) => pieceText(child, words)).join('');
  }
  const id = node.getAttribute(MENTION_SOURCE_ID_ATTR);
  const kind = node.getAttribute(MENTION_KIND_ATTR);
  return words(typeof id === 'string' ? id : null, typeof kind === 'string' ? kind : null);
}

/**
 * A prompt as the model reads it, the same text `serializePromptText` gives
 * for a mounted editor.
 * @param fragment - The prompt.
 * @param pool - The node's reference rows, for what a text chip says.
 * @param tokens - Each media chip's words, by source id.
 * @returns The text.
 */
export function serializePromptFragment(
  fragment: Y.XmlFragment,
  pool: ReadonlyArray<ReferenceRailItem>,
  tokens: MentionTokens,
): string {
  const words = chipWordsReader(pool, tokens);
  return fragment
    .toArray()
    .map((block) => pieceText(block, words))
    .join(BLOCK_SEPARATOR);
}
