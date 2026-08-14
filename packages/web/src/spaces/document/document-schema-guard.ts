// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as Y from 'yjs';
import type { DocumentSchema } from '@breatic/shared';

/**
 * Whether a document Space's stored content holds anything this build has no
 * vocabulary for, asked of the Yjs document directly.
 *
 * ## Why this does not go through the editor
 *
 * The whole point of finding out is to NOT create an editor: an editor that
 * exists is an editor whose keystrokes reach the shared document, and the four
 * ways an older build destroys newer content all start with one edit. So the
 * question has to be answerable before anything is built, which rules out
 * asking a live editor what it managed to parse.
 *
 * It also keeps this independent of the y-tiptap patch. The patch answers "do
 * not delete what you cannot represent"; this answers "do you know that you
 * received it". Neither needs the other to be right, and the second would be
 * the harder one to notice going wrong.
 *
 * ## What counts as unknown
 *
 * An element whose name is not in the vocabulary, and a mark whose name is not
 * in it. The fallback types ARE in the vocabulary, so content already wrapped
 * by some other client reads as known — correctly: whoever wrapped it had
 * already recognised that it was beyond them, and this build can represent the
 * wrapper.
 */

/**
 * Strip the hash y-tiptap appends to an overlapping mark's storage key.
 *
 * A mark that does not exclude itself is stored as `name--HASH`, so that two
 * of them can sit on the same span. Comparing that raw against the vocabulary
 * would report every overlapping mark as unknown, including ones this build
 * knows perfectly well.
 * @param key - The attribute key as stored on the Yjs text.
 * @returns The mark name without the hash suffix.
 */
function markNameOf(key: string): string {
  const at = key.lastIndexOf('--');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * Walk a stored document body and collect the names this build cannot resolve.
 * @param body - The Space's content fragment.
 * @param schema - This build's vocabulary.
 * @returns Every unresolvable node or mark name, each once, in encounter order.
 */
export function findUnknownContent(
  body: Y.XmlFragment,
  schema: DocumentSchema,
): string[] {
  const unknown = new Set<string>();

  /**
   * Look at one stored child and everything under it.
   * @param node - The child to inspect.
   */
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): void => {
    if (node instanceof Y.XmlText) {
      node.toDelta().forEach((run: { attributes?: Record<string, unknown> }) => {
        Object.keys(run.attributes ?? {}).forEach((key) => {
          const name = markNameOf(key);
          if (!(name in schema.marks)) unknown.add(name);
        });
      });
      return;
    }
    if (!(node instanceof Y.XmlElement)) return;
    if (!(node.nodeName in schema.nodes)) unknown.add(node.nodeName);
    node.forEach(visit);
  };

  body.forEach(visit);
  return [...unknown];
}
