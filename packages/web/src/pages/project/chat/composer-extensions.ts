// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Extension, type AnyExtension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { history, redo, undo } from '@tiptap/pm/history';
import type { SuggestionOptions } from '@tiptap/suggestion';

import { ChatReference } from '@web/pages/project/chat/chat-reference';
import type { TrayItem } from '@web/stores/chat-attachments';

/** Undo and redo for a box with no collaboration behind it. */
const ComposerHistory = Extension.create({
  name: 'composerHistory',
  addProseMirrorPlugins() {
    return [history()];
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => undo(this.editor.state, this.editor.view.dispatch),
      'Mod-Shift-z': () => redo(this.editor.state, this.editor.view.dispatch),
      'Mod-y': () => redo(this.editor.state, this.editor.view.dispatch),
    };
  },
});

/**
 * What the chat box is built from: plain paragraphs, undo, the placeholder,
 * and reference blocks. No formatting: what is sent is plain words.
 * @param input - The box's live inputs.
 * @param input.placeholder - Reads the placeholder sentence.
 * @param input.suggestion - The `@` list, when the box has one.
 * @returns The extensions.
 */
export function composerExtensions(input: {
  placeholder: () => string;
  suggestion?: Omit<SuggestionOptions<TrayItem>, 'editor'>;
}): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    ComposerHistory,
    Placeholder.configure({ placeholder: input.placeholder }),
    ChatReference.configure({ suggestion: input.suggestion ?? null }),
  ];
}
