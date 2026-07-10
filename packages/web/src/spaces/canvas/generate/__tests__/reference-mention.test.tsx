// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text } from '@tiptap/extension-text';
import { SuggestionPluginKey } from '@tiptap/suggestion';

import { ReferenceMention } from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';

/**
 * Mounts a bare editor carrying the ReferenceMention extension configured with
 * the `@` suggestion.
 * @returns The editor.
 */
function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      Document,
      Paragraph,
      Text,
      ReferenceMention.configure({
        suggestion: makeReferenceSuggestion({
          getPool: () => [],
          emptyLabel: 'No references',
        }),
      }),
    ],
  });
}

describe('ReferenceMention — @ suggestion wiring', () => {
  it('installs the @tiptap/suggestion ProseMirror plugin (so typing @ fires the picker)', () => {
    const editor = makeEditor();
    try {
      // The custom node stores the suggestion option; it must also INSTALL the
      // Suggestion plugin (addProseMirrorPlugins). Without it, typing `@` does
      // nothing — the popup never opens. A live plugin state proves it is wired.
      expect(SuggestionPluginKey.getState(editor.state)).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('registers the referenceMention node in the editor schema', () => {
    const editor = makeEditor();
    try {
      expect(editor.schema.nodes.referenceMention).toBeDefined();
    } finally {
      editor.destroy();
    }
  });

  it('triggers @ after ANY character, not only after a space (allowedPrefixes null)', () => {
    // @tiptap/suggestion defaults allowedPrefixes to [" "], so `@` only fires
    // when preceded by a space or at block start — typing `text@` (e.g. CJK
    // "额@") would NOT open the picker. Setting null lets `@` trigger anywhere.
    const suggestion = makeReferenceSuggestion({
      getPool: () => [],
      emptyLabel: 'No references',
    });
    expect(suggestion.allowedPrefixes).toBeNull();
  });
});
