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
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

import { resolveLinkInSpan } from '@web/spaces/document/document-link';

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
          // `resolveLinkInSpan` walks the mark out to both its ends, which is
          // what makes the whole link the answer: ProseMirror splits a text
          // node on its marks, so a link holding a styled word is two nodes,
          // and the one under the pointer is a part of what was pressed.
          const at = view.posAtDOM(anchor, 0);
          const { range } = resolveLinkInSpan(view.state, at, at + 1);
          if (range === null) return false;
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, range.from, range.to),
            ),
          );
          return true;
        },
      },
    }),
  ],
}) as never);
