import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

export type TextEditorBridgeStorage = {
  openGenerationAIMenu: (() => void) | null;
  openSelectionAIMenu: (() => void) | null;
};

export const TextEditorBridgeExtension = Extension.create({
  name: 'textEditorBridge',

  addStorage() {
    return {
      openGenerationAIMenu: null as (() => void) | null,
      openSelectionAIMenu: null as (() => void) | null,
    } satisfies TextEditorBridgeStorage;
  },
});

/** Reads bridge storage from the live editor instance (same object TipTap mutates). */
export function getTextEditorBridgeStorage(editor: Editor): TextEditorBridgeStorage {
  return (editor.storage as unknown as { textEditorBridge: TextEditorBridgeStorage }).textEditorBridge;
}
