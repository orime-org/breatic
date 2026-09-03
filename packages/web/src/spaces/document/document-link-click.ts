// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a click on a link in the body does.
 *
 * It selects the whole link. That is the mouse route into the link panel: the
 * panel acts on a link, and a click that left the caret where it landed would
 * leave the panel with a caret and no link (#903).
 *
 * The link extension's own handler does something else — `window.open(href,
 * target)` (`Link/helpers/clickHandler.ts:70-74`) — so this one has to answer
 * first and claim the event. `runsBefore` is the route the extension names for
 * exactly this: its own comment says wrapping the mark "lets other extensions
 * order their click handlers relative to the link click handler via
 * `runsBefore: ['link']`" (`Link/link.ts:218-221`).
 *
 * Navigating away is not a thing a click inside a document the reader is
 * editing should do.
 */

import { createExtension } from '@blocknote/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

/**
 * The span of the link covering a position, or null when none does.
 * @param doc - The document.
 * @param pos - A position inside a text node.
 * @returns That span.
 */
function linkSpanAt(
  doc: PMNode,
  pos: number,
): { from: number; to: number } | null {
  const linkType = doc.type.schema.marks['link'];
  if (!linkType) return null;
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, at) => {
    if (found !== null) return false;
    if (!node.isText) return true;
    if (at > pos || at + node.nodeSize < pos) return true;
    if (!node.marks.some((mark) => mark.type === linkType)) return true;
    found = { from: at, to: at + node.nodeSize };
    return false;
  });
  return found;
}

/**
 * The extension that gives a click on a link its meaning.
 * @returns The extension, for the assembly to register.
 */
export const documentLinkClickExtension = createExtension(() => ({
  key: 'documentLinkClick',
  runsBefore: ['link'],
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentLinkClick'),
      props: {
        handleClick: (view, _pos, event): boolean => {
          if (event.button !== 0 || !view.editable) return false;
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest('a');
          if (!anchor) return false;
          // Resolved from the anchor rather than from the position the event
          // carries: that one comes from the pointer's coordinates, and the
          // element the reader pressed is what this handler already has.
          const span = linkSpanAt(view.state.doc, view.posAtDOM(anchor, 0));
          if (span === null) return false;
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, span.from, span.to),
            ),
          );
          return true;
        },
      },
    }),
  ],
}) as never);
