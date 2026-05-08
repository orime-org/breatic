import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';

/** Set on a transaction with `tr.setMeta(..., true)` to hide the format bubble after this update until the user changes selection. */
export const BREATIC_SUPPRESS_FORMAT_BUBBLE_META = 'breaticSuppressFormatBubble' as const;

const formatBubbleSuppressKey = new PluginKey<boolean>('breaticFormatBubbleSuppress');

export function isFormatBubbleSuppressed(state: EditorState): boolean {
  return formatBubbleSuppressKey.getState(state) === true;
}

/**
 * Keeps plugin state: suppressed after a flagged transaction; cleared on any later `selectionSet`.
 */
export const FormatBubbleSuppress = Extension.create({
  name: 'formatBubbleSuppress',

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: formatBubbleSuppressKey,
        state: {
          init: () => false,
          apply(tr, suppressed) {
            if (tr.getMeta(BREATIC_SUPPRESS_FORMAT_BUBBLE_META) === true) return true;
            if (tr.selectionSet) return false;
            return suppressed;
          },
        },
      }),
    ];
  },
});
