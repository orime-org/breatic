// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Mark, Node } from '@tiptap/core';

/**
 * Somewhere to put content this build has no vocabulary for, so that receiving
 * it is not the same as destroying it.
 *
 * A document Space stores its content as a Yjs XML fragment whose element
 * names ARE this editor's node names. A tab left open across a release meets
 * names it has never heard of, and y-tiptap's answer — in the `catch` around
 * building the node — is to delete the element from the SHARED document. The
 * other person's paragraph is gone for everyone, and nothing anywhere says so.
 *
 * These three types are where the patched y-tiptap puts such content instead.
 * They carry the original name so the console can say what was lost, and the
 * mark carries the original value so a round trip through this client leaves
 * the shared document byte-for-byte as it was.
 *
 * ## They have to ship before they are needed
 *
 * A fallback only works if the client that meets the unknown content already
 * has it. Adding these the day something breaks helps nobody: the tabs already
 * open — the ones the whole problem is about — do not know these names either,
 * and delete exactly as before. That is why they are here now, while there is
 * nothing to catch.
 *
 * ## Why two node types rather than one
 *
 * Where an unknown element sits decides which one can hold it, and the two
 * positions fail differently. An unknown BLOCK is a block among blocks: swap
 * in a block-level stand-in and the surrounding document still parses. An
 * unknown INLINE element sits inside a paragraph's inline content, where a
 * block-level stand-in is not valid — the paragraph would fail to build and
 * y-tiptap would drop the element from the shared document. Measured: an
 * unknown inline child disappears from the shared fragment while the document
 * merely LOADS, with no edit involved and no chance for the interceptor to
 * exist yet.
 *
 * The shape follows Atlassian's ADF (`@atlaskit/adf-schema`), which solves the
 * same problem with the same pair of node types and an equivalent mark.
 */

/** Attribute holding the type name this build could not resolve. */
const ORIGINAL_NAME = 'originalName';

/**
 * A block this build cannot represent, kept whole in the shared document.
 *
 * `atom` because there is nothing inside it this build could edit; `selectable`
 * because that is what an atom block is, even though the intercept state means
 * nobody will be selecting it.
 */
export const UnsupportedBlock = Node.create({
  name: 'unsupportedBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { [ORIGINAL_NAME]: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'div[data-unsupported-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-unsupported-block': '',
        'data-original-name': HTMLAttributes[ORIGINAL_NAME],
      },
    ];
  },
});

/**
 * An inline element this build cannot represent, kept in place in the text.
 *
 * Without this one, an unknown inline element is dropped from the shared
 * document as the document loads — before any interception can happen, because
 * no edit is involved.
 */
export const UnsupportedInline = Node.create({
  name: 'unsupportedInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { [ORIGINAL_NAME]: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'span[data-unsupported-inline]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-unsupported-inline': '',
        'data-original-name': HTMLAttributes[ORIGINAL_NAME],
      },
    ];
  },
});

/**
 * A mark this build cannot represent, carried across untouched.
 *
 * `excludes: ''` so it never displaces anything: a span of text can hold
 * several unknown marks at once alongside the ones this build does know, which
 * is the only way a round trip can be lossless.
 *
 * It keeps the original VALUE as well as the name, because unlike the two node
 * types this one is written back: y-tiptap stores marks as attributes on the
 * Yjs text, so putting the span back requires reproducing the exact key and
 * value it arrived with.
 */
export const UnsupportedMark = Mark.create({
  name: 'unsupportedMark',
  excludes: '',

  addAttributes() {
    return {
      [ORIGINAL_NAME]: { default: null },
      originalValue: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-unsupported-mark]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      {
        'data-unsupported-mark': '',
        'data-original-name': HTMLAttributes[ORIGINAL_NAME],
      },
      0,
    ];
  },
});
