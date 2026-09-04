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
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import {
  createExtension,
  createBlockSpecFromTiptapNode,
  createInlineContentSpecFromTipTapNode,
  NON_FORMATTING_MARK_GROUP,
} from '@blocknote/core';

import { t } from '@breatic/shared';

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
 * What the block and the inline node declare to BlockNote's own schemas.
 *
 * `originalName` arrives as null on a node the binding built without one, and
 * `nodeToBlock` copies an attribute named here whatever its value, so the
 * declaration says the type and leaves the default absent.
 */
const NAME_PROP = {
  [ORIGINAL_NAME]: { default: undefined, type: 'string' },
} as const;

/**
 * The block, declared to the block schema as well as to ProseMirror's.
 *
 * BlockNote keeps a second registry beside the ProseMirror schema, and every
 * route that hands out a block object looks a node up in it: `nodeToBlock.ts:427`
 * throws for a type it cannot find, and `getTextCursorPosition` — which
 * `SourceBlockWithPreview` calls on every selection change — converts the
 * block at the cursor along with its previous, next and parent. A stand-in
 * absent from that registry therefore raises out of `view.dispatch` when the
 * caret so much as arrives in a neighbouring block, which is the opposite of
 * what these three are for.
 *
 * The tiptap node goes in unchanged, so the patched binding still reaches it by
 * name through `type.create(...)` and builds it straight from Yjs.
 */
export const unsupportedBlockSpec = createBlockSpecFromTiptapNode(
  { node: UnsupportedBlock, type: 'unsupportedBlock', content: 'none' },
  NAME_PROP,
);

/**
 * The inline node, declared to the inline content schema.
 *
 * This one fails the other way. `nodeToBlock.ts:180-185` writes a console
 * warning for an inline type absent from that schema and returns, so the
 * stand-in is dropped from the block object without a word — and a document
 * read back that way has lost the element the stand-in was carrying.
 */
export const unsupportedInlineSpec = createInlineContentSpecFromTipTapNode(
  UnsupportedInline,
  NAME_PROP,
  { render: () => ({ dom: document.createElement('span') }) },
);

/** The two node names the label decoration dresses. */
const LABELLED = new Set(['unsupportedBlock', 'unsupportedInline']);

/**
 * The label decorations for every stand-in in the document.
 *
 * A stand-in holds nothing this build can draw, so without a label it renders
 * as an empty box and the reader has no way to know something is there.
 *
 * The text travels as a `data-label` DECORATION painted by index.css through
 * `content: attr(data-label)`, rather than as text baked into `renderHTML`.
 * `renderHTML` runs once per node and its output is what a copy carries, so a
 * label written there would be frozen in whatever language was active — and it
 * would follow the content out through the clipboard. A decoration is redrawn
 * from the live locale on every dispatch, and `documentLocaleRedrawExtension`
 * asks for that dispatch when the language changes.
 * @param state - The editor state to read.
 * @returns The decoration set, or null when the document holds no stand-in.
 */
function labelDecorations(state: EditorState): DecorationSet | null {
  const found: Decoration[] = [];
  const label = t('spaces.document.unsupported.label');
  state.doc.descendants((node, pos) => {
    if (LABELLED.has(node.type.name)) {
      found.push(
        Decoration.node(pos, pos + node.nodeSize, { 'data-label': label }),
      );
    }
    return true;
  });
  return found.length > 0 ? DecorationSet.create(state.doc, found) : null;
}

/**
 * The extension that registers the mark and dresses the stand-ins.
 *
 * The other two nodes are registered by the schema, which is where BlockNote
 * reads both of their declarations from. A mark has neither: `blocknoteIgnore`
 * above is what keeps this one out of the same conversion.
 */
export const documentFallbackExtension = createExtension(() => ({
  key: 'documentFallbacks',
  tiptapExtensions: [UnsupportedMark],
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentFallbackLabels'),
      props: { decorations: labelDecorations },
    }),
  ],
}) as never);
