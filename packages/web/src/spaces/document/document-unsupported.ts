// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Mark, Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { t } from '@breatic/shared';

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
 * mark carries the original value so the Yjs-to-ProseMirror-and-back trip
 * through this client leaves the shared document byte-for-byte as it was.
 *
 * That is the only trip they take. None of them can be parsed from HTML — see
 * the note where a `parseHTML` would have gone.
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

/** The two node names the label decoration dresses. */
const LABELLED_NODES = new Set(['unsupportedBlock', 'unsupportedInline']);

/**
 * The label decorations for every stand-in node in the document.
 * @param state - The editor state to read.
 * @returns The decoration set, or null when the document holds no stand-ins.
 */
function labelDecorations(state: EditorState): DecorationSet | null {
  const found: Decoration[] = [];
  const label = t('spaces.document.unsupported.label');
  state.doc.descendants((node, pos) => {
    if (LABELLED_NODES.has(node.type.name)) {
      found.push(
        Decoration.node(pos, pos + node.nodeSize, { 'data-label': label }),
      );
    }
    return true;
  });
  return found.length > 0 ? DecorationSet.create(state.doc, found) : null;
}

/**
 * A block this build cannot represent, kept whole in the shared document.
 *
 * `atom` because there is nothing inside it this build could edit; `selectable`
 * because selecting it is how a user deletes it — a document holding one stays
 * editable, since the read-only intercept answers to the published schema
 * version alone.
 *
 * Both node types show a localized "unsupported content" label. Without it
 * the stand-in is an empty element at zero height: present, selectable in
 * principle, and impossible to see or click — measured in the browser on a
 * legacy document whose retired block came back through the fallback.
 *
 * The label travels as a `data-label` DECORATION, painted by index.css
 * through `content: attr(data-label)` — not as text baked into `renderHTML`.
 * A node's DOM is redrawn only when the node itself changes, so baked-in text
 * freezes in whichever language was active when the node was first drawn;
 * decorations are recomputed on every dispatch, and `LocaleRedraw`'s empty
 * dispatch on a language switch is what carries the new string in — the same
 * mechanism the empty-document placeholder rides.
 */
export const UnsupportedBlock = Node.create({
  name: 'unsupportedBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return { [ORIGINAL_NAME]: { default: null } };
  },

  // No `parseHTML`. Nothing in this Space ever hands ProseMirror HTML to parse
  // (no `setContent`, no `getHTML`), and an entry that did exist could not work:
  // `renderHTML` cannot emit what it does not know how to read back, so a name
  // would come in as null and be written to the shared document as the literal
  // key "null". These types are built by the y-tiptap patch straight from Yjs
  // and go back the same way.
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      {
        'data-unsupported-block': '',
        'data-original-name': HTMLAttributes[ORIGINAL_NAME],
      },
    ];
  },

  /**
   * The label decorations for BOTH stand-in node types — hung off this one
   * extension because a single plugin walking the document once beats one per
   * type walking it twice.
   * @returns The one plugin.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('unsupportedLabels'),
        props: {
          decorations: labelDecorations,
        },
      }),
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

  // No `parseHTML`, for the reason on `UnsupportedBlock`.
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

  // No `parseHTML`, for the reason on `UnsupportedBlock`, and here the value
  // matters as well as the name: `renderHTML` deliberately does not put
  // `originalValue` in the DOM, so an HTML round trip could never be lossless.
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
