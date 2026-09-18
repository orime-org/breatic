// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A modifier-click is a plain click here (user 2026-09-18).
 *
 * ProseMirror answers a click held with the platform's node modifier — Cmd on
 * a Mac, Ctrl elsewhere (`prosemirror-view/src/input.ts:278`) — by selecting
 * the whole block as a `NodeSelection`
 * (`:413` hands `this.selectNode` to `handleSingleClick`, which calls
 * `selectClickedNode`). This Space does not offer selecting a block that way:
 * every command that acts on a whole block is on the block handle, and the
 * reader's selection is for text.
 *
 * Measured 2026-09-18 before this: the gesture put a node selection on every
 * row it was tried on — a heading, a paragraph and an empty row — which
 * brought the bubble bar up over rows that had words in them while nothing was
 * selected as far as the reader could tell. (It also drew a frame around the
 * row; that frame was removed the same day, so the bar is what is left.)
 *
 * WHAT THE CLICK DOES INSTEAD. The caret goes where it landed, which is what
 * the same click without the modifier does. `handleClick` is asked before
 * ProseMirror decides between a node selection and a leaf selection
 * (`input.ts:404-407`), so answering it here settles the gesture.
 *
 * A LINK IS NOT THIS SPACE'S TO ANSWER. Holding the same modifier over a link
 * is how a reader opens one in a new tab, and `handleClick` is the prop the
 * link handler is registered on too — whichever plugin answers true first gets
 * `preventDefault` called and the rest are never asked. So a press over a link
 * anchor is declined here and BlockNote's own handler takes it.
 */

import { createExtension } from '@blocknote/core';
import { isMacOS } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';

import { LINK_ANCHOR_SELECTOR } from '@web/spaces/document/document-link';

/**
 * Whether this press carries the modifier ProseMirror reads as "select the
 * node".
 *
 * The platform split is the library's own (`input.ts:278`): a Mac reads the
 * command key, everything else the control key.
 * @param event - The press.
 * @returns True when the press asks for a node selection.
 */
function asksForANode(event: MouseEvent): boolean {
  return isMacOS() ? event.metaKey : event.ctrlKey;
}

/**
 * Whether the pointer was over a link.
 * @param event - The press.
 * @returns True when the press landed inside a link anchor.
 */
function landedOnALink(event: MouseEvent): boolean {
  const target = event.target as Element | null;
  return target?.closest(LINK_ANCHOR_SELECTOR) != null;
}

/**
 * The extension that keeps a modifier-click from selecting a block.
 * @returns The extension, for the assembly to register.
 */
export const documentNoNodeClickExtension = createExtension(() => ({
  key: 'document-no-node-click',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentNoNodeClick'),
      props: {
        /**
         * Puts the caret where the click landed and stops there.
         * @param view - The view the click happened in.
         * @param pos - Where in the document the click landed.
         * @param event - The click.
         * @returns True when this answered the click.
         */
        handleClick: (view, pos, event) => {
          if (!asksForANode(event)) return false;
          if (landedOnALink(event)) return false;
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, pos),
            ),
          );
          return true;
        },
      },
    }),
  ],
}) as never);
