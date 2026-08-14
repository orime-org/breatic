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
 * in it. The fallback types are in the vocabulary too, so an element carrying
 * one of those names reads as known.
 *
 * That last part is a property of the check, not a case it handles: nothing
 * writes a fallback name into the shared document. The patch builds a
 * ProseMirror node and maps it, touching no Yjs bytes, and `marksToAttributes`
 * puts the original key and value back on the way out — deliberately, so a
 * client that cannot represent something never renames it for everyone else.
 */

/**
 * A mark storage key's hash suffix, exactly as y-tiptap defines it.
 *
 * Copied character for character from `hashedMarkNameRegex` in
 * `@tiptap/y-tiptap@3.0.8`'s `dist/y-tiptap.js`, because the module does not
 * export it. It has to be the same rule: y-tiptap decides what a stored key
 * means, and reading it by a rule of our own means disagreeing with it on some
 * input. A looser one — cutting at the last `--` — reads a mark genuinely named
 * `some--mark` as `some`, and then reports a name nobody has.
 *
 * Upgrading `@tiptap/*` means re-checking this against the new source, the same
 * way the y-tiptap patch has to be.
 */
const HASHED_MARK_NAME = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

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
  return HASHED_MARK_NAME.exec(key)?.[1] ?? key;
}

/**
 * Whether a name is one of the type names in a vocabulary.
 *
 * `Object.hasOwn`, not `in`: the vocabulary is a plain object literal, so it
 * carries `Object.prototype`, and `in` answers yes to `toString`,
 * `constructor` and the rest. The patch asks the same question of ProseMirror's
 * `schema.nodes`, which is built with `Object.create(null)` and has no
 * prototype — so `in` here means the two sides answer differently about the
 * same document, one wrapping a name in a fallback while the other reports
 * nothing to intercept.
 * @param types - One half of a vocabulary.
 * @param name - The stored type name.
 * @returns True when this build has that type.
 */
function knows(types: Record<string, string[]>, name: string): boolean {
  return Object.hasOwn(types, name);
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
          if (!knows(schema.marks, name)) unknown.add(name);
        });
      });
      return;
    }
    if (!(node instanceof Y.XmlElement)) return;
    if (!knows(schema.nodes, node.nodeName)) unknown.add(node.nodeName);
    node.forEach(visit);
  };

  body.forEach(visit);
  return [...unknown];
}
