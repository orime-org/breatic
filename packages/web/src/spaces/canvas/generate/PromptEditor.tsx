// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Collaboration } from '@tiptap/extension-collaboration';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import * as React from 'react';
import type * as Y from 'yjs';

interface PromptEditorProps {
  /** The node's prompt Y.XmlFragment — the collaborative binding target. */
  fragment: Y.XmlFragment;
  /** Placeholder shown while the prompt is empty. */
  placeholder: string;
  /** Called with the current plain-text prompt (drives the execute gate). */
  onTextChange: (text: string) => void;
}

/**
 * The Generate panel's collaborative prompt editor. Slice 1 is plain text: a
 * minimal TipTap schema (Document / Paragraph / Text) bound to the node's
 * prompt Y.XmlFragment via the Collaboration extension, so every collaborator
 * sees keystrokes live (rich text + @-mentions arrive in slice 2). `useEditor`
 * owns the editor lifecycle (create on mount, destroy on unmount — StrictMode
 * safe); the fragment is external Yjs data and is never destroyed here.
 * @param root0 - Component props.
 * @param root0.fragment - The prompt Y.XmlFragment to bind to.
 * @param root0.placeholder - Empty-state placeholder text.
 * @param root0.onTextChange - Receives the current plain-text prompt.
 * @returns The prompt editor.
 */
export function PromptEditor({
  fragment,
  placeholder,
  onTextChange,
}: PromptEditorProps): React.JSX.Element {
  const editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        // Collaboration provides history (yUndo); do NOT add UndoRedo alongside.
        Collaboration.configure({ fragment }),
        Placeholder.configure({ placeholder }),
      ],
      immediatelyRender: false,
      onCreate: ({ editor: e }) => onTextChange(e.getText()),
      onUpdate: ({ editor: e }) => onTextChange(e.getText()),
    },
    [fragment],
  );
  return (
    <EditorContent
      editor={editor}
      data-testid='generate-prompt-editor'
      className='max-h-40 min-h-[3.5rem] overflow-auto rounded-md border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-within:ring-2 focus-within:ring-ring [&_.ProseMirror]:min-h-[2.5rem] [&_.ProseMirror]:outline-none [&_p.is-editor-empty:first-child::before]:pointer-events-none [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:text-muted-foreground [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]'
    />
  );
}
