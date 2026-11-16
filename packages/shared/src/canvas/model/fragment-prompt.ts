// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A prompt read straight off its fragment, with no editor mounted (#2218,
 * design §5.4).
 *
 * The multi-shot mode sends every shot's words and the union of what the
 * shots mention. Both are read at submit from the shots the node holds right
 * then, so a shot a collaborator removed a moment ago cannot linger in either
 * the way it would in a list the editors report into.
 */

import * as Y from 'yjs';

import { MENTION_SOURCE_ID_ATTR, REFERENCE_MENTION_NODE } from '@shared/canvas/model/prompt-nodes.js';
import { promptPieces, serializePromptPieces } from '@shared/canvas/model/prompt-pieces.js';
import type { ReferenceRailItem } from '@shared/canvas/model/derive-references.js';
import type { MentionTokens } from '@shared/canvas/model/reference-urls.js';

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
 * A prompt as the model reads it, the same text `serializePromptText` gives
 * for a mounted editor: the pieces {@link promptPieces} reads, joined by
 * {@link serializePromptPieces}, so reading in one step or two follows one rule.
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
  return serializePromptPieces(promptPieces(fragment), pool, tokens);
}
