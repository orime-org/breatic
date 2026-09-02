// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Stand-ins for vocabulary this build does not know.
 *
 * A newer build of ours writes a block type, an inline type or a mark that
 * this one has never heard of. The binding rebuilds every node by calling
 * `schema.node(...)`, which throws on an unknown name, and its error handler
 * answers by DELETING the element from the shared Yjs document and
 * broadcasting that deletion as this client's own edit. The other side loses
 * content it can display perfectly well, and nobody is told.
 *
 * The patched binding looks these three up BY NAME. A rename here, or a build
 * that forgets to register them, makes the patch fall through to that same
 * deletion — silently. `blocknote-fallback-schema.test.ts` is what holds the
 * names and the switches in place.
 *
 * ## Why three types and not one
 *
 * They occupy positions that fail differently. A block-level stand-in inside
 * a paragraph is not valid content, so the paragraph itself would fail to
 * build and the whole sentence would go with it. A mark is not a node at all:
 * it rides on text, and it is the only one of the three that gets written
 * BACK, so it keeps the original value as well as the name.
 *
 * ## Why they have no `parseHTML`
 *
 * Nothing in this Space hands ProseMirror HTML to parse, and an entry that
 * did exist could not work: `renderHTML` cannot emit a name it has no way to
 * read back, so the name would return as null and be written to the shared
 * document as the literal key "null". These types are built by the patched
 * binding straight from Yjs and go back the same way. Content arriving on the
 * clipboard therefore never becomes one of them.
 */

import { Mark, Node } from '@tiptap/core';
import { createExtension, NON_FORMATTING_MARK_GROUP } from '@blocknote/core';

/** The attribute every stand-in carries: the name this build could not use. */
const ORIGINAL_NAME = 'originalName';

/** The attribute the mark carries in addition: the value it arrived with. */
const ORIGINAL_VALUE = 'originalValue';

/**
 * A block this build cannot represent.
 *
 * `group: 'blockContent'` is what a block's own node belongs to in BlockNote's
 * three-level document. The two container positions — a `blockGroup`'s child
 * and the fragment root — are reached by WRAPPING this node, not by adding
 * groups to it: both of those slots name one exact node type rather than a
 * group, so nothing can join them by declaration.
 */
export const UnsupportedBlock = Node.create({
  name: 'unsupportedBlock',
  group: 'blockContent',
  atom: true,
  selectable: true,

  addAttributes() {
    return { [ORIGINAL_NAME]: { default: null } };
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

/** An inline node this build cannot represent. */
export const UnsupportedInline = Node.create({
  name: 'unsupportedInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { [ORIGINAL_NAME]: { default: null } };
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
 * Two switches, both load-bearing:
 *
 * `excludes: ''` — one span of text can carry several unknown marks at once
 * alongside the ones this build does know. The binding pushes one stand-in per
 * unknown attribute, so the default (a mark excludes its own type) would let
 * each new one displace the last and only the final one would survive.
 *
 * `NON_FORMATTING_MARK_GROUP` — a `plain` block, which is what a code block
 * is, allows only that group, and BlockNote's own schema repair strips marks
 * the node type does not allow. Without the group, an unknown mark inside a
 * code block is dropped on load.
 */
export const UnsupportedMark = Mark.create({
  name: 'unsupportedMark',
  excludes: '',
  group: NON_FORMATTING_MARK_GROUP,

  addAttributes() {
    return {
      [ORIGINAL_NAME]: { default: null },
      [ORIGINAL_VALUE]: { default: null },
    };
  },

  renderHTML({ HTMLAttributes }) {
    // `originalValue` deliberately stays out of the DOM: an HTML round trip
    // could never be lossless anyway, and putting an arbitrary value into an
    // attribute is a surface nothing needs.
    return [
      'span',
      {
        'data-unsupported-mark': '',
        'data-original-name': HTMLAttributes[ORIGINAL_NAME],
      },
      0,
    ];
  },

  /**
   * Keeps this mark out of BlockNote's block JSON.
   *
   * `nodeToBlock` walks every mark on a text node and looks it up in the style
   * schema; a mark it cannot find there throws `style ... not found in
   * styleSchema` unless the spec carries this flag. Registering the stand-in
   * as a style instead would be worse: it would then appear as a formatting
   * option and round-trip through a shape that has no room for the original
   * key and value.
   * @param extension - The extension being asked.
   * @returns The spec addition, for this mark only.
   */
  extendMarkSchema(extension) {
    if (extension.name !== this.name) {
      return {};
    }
    return { blocknoteIgnore: true };
  },
});

/**
 * The extension that registers all three, for the assembly to pass through.
 *
 * They go in as plain tiptap types rather than through `createBlockSpec` and
 * friends: those wrap a node in BlockNote's block model, while these are built
 * by the patched binding calling `type.create(...)` straight from Yjs.
 */
export const documentFallbackExtension = createExtension(() => ({
  key: 'documentFallbacks',
  tiptapExtensions: [UnsupportedBlock, UnsupportedInline, UnsupportedMark],
}) as never);
