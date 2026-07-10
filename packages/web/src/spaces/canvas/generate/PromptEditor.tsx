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

import {
  extractAtMentionedSourceIds,
  planMentionDeletions,
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
  type MentionOccurrence,
} from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import { ReferenceMention } from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';

interface PromptEditorProps {
  /** The node's prompt Y.XmlFragment — the collaborative binding target. */
  fragment: Y.XmlFragment;
  /** Placeholder shown while the prompt is empty. */
  placeholder: string;
  /** Called with the current plain-text prompt (drives the execute gate). */
  onTextChange: (text: string) => void;
  /**
   * Called with the source node ids `@`-picked in the prompt (first-appearance
   * order, de-duped). Fires alongside {@link PromptEditorProps.onTextChange} so
   * the container can snapshot the i2i source subset at execute time — same
   * "report the derived value up, keep TipTap encapsulated" contract as the text.
   */
  onAtMentionsChange: (sourceIds: string[]) => void;
  /** Current reference pool (incoming edges) — the `@` picker's options. */
  references: ReferenceRailItem[];
  /** Active generation sub-mode; t2i greys out existing `@` mentions (design §2.4 C). */
  mode: ImageGenMode;
  /** Localized empty-state text for the `@` picker popup. */
  mentionEmptyLabel: string;
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
 * @param root0.onAtMentionsChange - Receives the `@`-picked source node ids.
 * @param root0.references - The current reference pool (the `@` picker options).
 * @param root0.mode - Active generation sub-mode (t2i greys out `@` chips).
 * @param root0.mentionEmptyLabel - Localized empty-state text for the `@` popup.
 * @returns The prompt editor.
 */
export function PromptEditor({
  fragment,
  placeholder,
  onTextChange,
  onAtMentionsChange,
  references,
  mode,
  mentionEmptyLabel,
}: PromptEditorProps): React.JSX.Element {
  // The reference pool changes as edges are added / removed, but the editor is
  // rebuilt only on `fragment` change. A ref keeps the `@` suggestion reading
  // the CURRENT pool without recreating the editor.
  const poolRef = React.useRef(references);
  poolRef.current = references;
  const editor = useEditor(
    {
      extensions: [
        Document,
        Paragraph,
        Text,
        // Collaboration provides history (yUndo); do NOT add UndoRedo alongside.
        Collaboration.configure({ fragment }),
        Placeholder.configure({ placeholder }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({
            getPool: () => poolRef.current,
            emptyLabel: mentionEmptyLabel,
          }),
        }),
      ],
      immediatelyRender: false,
      // Report BOTH derived values on every editor change (create + update): the
      // plain text (execute gate) and the `@`-picked source ids (i2i subset).
      // Remote collaborator edits also fire onUpdate via y-prosemirror, so the
      // container's mirrors stay current for both local and remote changes.
      onCreate: ({ editor: e }) => {
        onTextChange(e.getText());
        onAtMentionsChange(extractAtMentionedSourceIds(e.getJSON()));
      },
      onUpdate: ({ editor: e }) => {
        onTextChange(e.getText());
        onAtMentionsChange(extractAtMentionedSourceIds(e.getJSON()));
      },
    },
    [fragment],
  );
  // Cascade-clear stale @-mention chips: when a reference edge is removed the
  // pool shrinks, so any @-mention pointing at a now-disconnected source must
  // disappear from the prompt (design §2.1 — a mention only picks from the
  // pool). Collect the mention occurrences, plan the deletions purely, then
  // apply them in one transaction (synced to collaborators via Collaboration).
  React.useEffect(() => {
    if (!editor) return;
    const poolIds = new Set(references.map((r) => r.sourceNodeId));
    const occurrences: MentionOccurrence[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name !== REFERENCE_MENTION_NODE) return;
      const id: unknown = n.attrs[MENTION_SOURCE_ID_ATTR];
      if (typeof id === 'string') {
        occurrences.push({ sourceNodeId: id, from: pos, to: pos + n.nodeSize });
      }
    });
    const deletions = planMentionDeletions(occurrences, poolIds);
    if (deletions.length === 0) return;
    // Deletions are sorted highest-position-first, so each delete leaves the
    // remaining (lower) positions valid.
    const tr = editor.state.tr;
    for (const { from, to } of deletions) tr.delete(from, to);
    editor.view.dispatch(tr);
  }, [editor, references]);
  // t2i greys out existing @-mention chips (design §2.4 C): the mode switch
  // visually pre-announces they will not take effect; execute filters them out.
  const dimReferences =
    mode === 't2i'
      ? ' [&_.reference-mention]:opacity-40 [&_.reference-mention]:grayscale'
      : '';
  return (
    <EditorContent
      editor={editor}
      data-testid='generate-prompt-editor'
      className={
        'nowheel max-h-40 min-h-[3.5rem] overflow-auto rounded-overlay border border-border bg-background px-2.5 py-2 text-sm text-foreground focus-within:ring-1 focus-within:ring-ring [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-track]:bg-transparent [&_.ProseMirror]:min-h-[2.5rem] [&_.ProseMirror]:outline-none [&_p.is-editor-empty:first-child::before]:pointer-events-none [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:text-muted-foreground [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]' +
        dimReferences
      }
    />
  );
}
