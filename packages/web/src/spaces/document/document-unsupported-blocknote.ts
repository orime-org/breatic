// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The browser's dress for the stand-ins `@breatic/shared/document-model`
 * defines for vocabulary this build does not know: the extension that
 * registers the fallback mark and labels each stand-in. Why the stand-ins
 * exist, and why their names must not change, is in the shared module.
 */

import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { createExtension } from '@blocknote/core';

import { t } from '@breatic/shared';
import { UNSUPPORTED_BLOCK, UNSUPPORTED_INLINE, UnsupportedMark } from '@breatic/shared/document-model';

import { CONTENT_DECORATION } from '@web/spaces/document/document-view-state';

/** The two node names the label decoration dresses. */
const LABELLED = new Set([UNSUPPORTED_BLOCK, UNSUPPORTED_INLINE]);

/**
 * The label decorations for every stand-in in the document.
 *
 * A stand-in holds nothing this build can draw, so without a label it renders
 * as an empty box and the user has no way to know something is there.
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
        Decoration.node(pos, pos + node.nodeSize, { 'data-label': label }, CONTENT_DECORATION),
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
