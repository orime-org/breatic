// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which presses on the end-of-document affordance open a block.
 *
 * BlockNote draws that affordance and answers `mousedown` on it with an
 * `insertBlocks` — no button check, no modifier check
 * (`TrailingNode`'s widget, in `@blocknote/core`). Every press writes into the
 * shared document: measured, the right button, the middle button and each of
 * the four modifiers all appended a paragraph.
 *
 * The editor this Space replaced turned all of them away, and its own comment
 * said why: a modifier turns a press into a different gesture, and acting on
 * one both loses that gesture and writes a block nobody asked for into a
 * document other people are in.
 *
 * The check runs in the capture phase on the editable surface, so it reaches
 * the press before the widget's own listener does.
 */

import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/** The class BlockNote gives the affordance. */
const TRAILING_CLASS = 'bn-trailing-block';

/**
 * Whether this press is the plain left one that asks to start writing.
 * @param event - The press.
 * @returns True when nothing about it says a different gesture.
 */
function opensABlock(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

/**
 * The extension that holds the affordance to one gesture.
 * @returns The extension, for the assembly to register.
 */
export const documentTrailingPressExtension = createExtension(() => ({
  key: 'document-trailing-press',
  prosemirrorPlugins: [
    new Plugin({
      key: new PluginKey('documentTrailingPress'),
      /**
       * Watches the editable surface for as long as it is mounted.
       * @param view - The view this plugin was added to.
       * @returns The hook that takes the listener back off.
       */
      view: (view) => {
        /**
         * Stops a press that is not the one gesture this affordance answers.
         * @param event - The press.
         */
        const onPress = (event: MouseEvent): void => {
          const target = event.target as HTMLElement | null;
          if (target?.closest(`.${TRAILING_CLASS}`) === null) return;
          if (opensABlock(event)) return;
          // The widget's own listener sits on the element itself, so stopping
          // the press here — before it reaches that element — is what keeps it
          // from writing.
          event.stopPropagation();
        };
        view.dom.addEventListener('mousedown', onPress, true);
        return {
          destroy: () => {
            view.dom.removeEventListener('mousedown', onPress, true);
          },
        };
      },
    }),
  ],
}) as never);
