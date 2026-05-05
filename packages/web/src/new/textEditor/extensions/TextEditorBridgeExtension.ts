import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

export type TextEditorBridgeStorage = {
  openGenerationAIMenu: ((initialReplacement?: string | null) => void) | null;
  openSelectionAIMenu:
    | ((options?: { initialReplacement?: string | null; range?: { from: number; to: number } }) => void)
    | null;
};

export const TextEditorBridgeExtension = Extension.create({
  name: 'textEditorBridge',

  addStorage() {
    return {
      openGenerationAIMenu: null as ((initialReplacement?: string | null) => void) | null,
      openSelectionAIMenu: null as
        | ((options?: { initialReplacement?: string | null; range?: { from: number; to: number } }) => void)
        | null,
    } satisfies TextEditorBridgeStorage;
  },
});

/** Reads bridge storage from the live editor instance (same object TipTap mutates). */
export function getTextEditorBridgeStorage(editor: Editor): TextEditorBridgeStorage {
  return (editor.storage as unknown as { textEditorBridge: TextEditorBridgeStorage }).textEditorBridge;
}
