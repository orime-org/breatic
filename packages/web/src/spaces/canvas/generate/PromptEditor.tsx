// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
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
import {
  renderCollabCaret,
  renderCollabSelection,
} from '@web/spaces/canvas/generate/caret-render';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';
import {
  ReferenceMention,
  referenceMentionContent,
  serializePromptText,
} from '@web/spaces/canvas/generate/reference-mention';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';

/** Imperative handle exposed to the container to insert a reference at the cursor. */
export interface PromptEditorHandle {
  /**
   * Inserts a reference-mention at the current cursor, or appends it to the end
   * when the editor has no live cursor (user 2026-07-10 item 8).
   * @param item - The reference pool row to insert.
   */
  insertReference: (item: ReferenceRailItem) => void;
  /**
   * Serializes the backend-bound prompt string RIGHT NOW (spec §9.1): text
   * chips substitute their source node's current content, image chips
   * contribute nothing. Called at execute-click so a text node edited since
   * the last prompt keystroke still lands its latest words.
   * @returns The backend prompt string, or null when the editor is not ready.
   */
  serializePrompt: () => string | null;
}

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
  /**
   * The canvas-space doc's provider (its awareness carries collaborator
   * carets — batch-2 item 14). Null until the socket connects; the caret
   * extension mounts only when present (it throws on a null provider).
   */
  caretProvider?: Pick<HocuspocusProvider, 'awareness'> | null;
  /**
   * This user's identity shown at their caret on OTHER clients: display name,
   * a concrete 6-digit hex (what the wire carries — y-prosemirror validates
   * it), and the palette hue breatic receivers actually render from (see
   * `user-color.ts` / `caret-render.ts`).
   */
  caretUser?: { name: string; color: string; hue: string } | null;
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
 * @param root0.caretProvider - Canvas-space doc provider whose awareness carries collaborator carets (null until connected).
 * @param root0.caretUser - This user's caret identity (name + palette color) published to other clients.
 * @param ref - Imperative handle exposing `insertReference` (click-to-insert).
 * @returns The prompt editor.
 */
export const PromptEditor = React.forwardRef<
  PromptEditorHandle,
  PromptEditorProps
>(function PromptEditor(
  {
    fragment,
    placeholder,
    onTextChange,
    onAtMentionsChange,
    references,
    mode,
    mentionEmptyLabel,
    caretProvider = null,
    caretUser = null,
  }: PromptEditorProps,
  ref,
): React.JSX.Element {
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
        // The caret between two adjacent chips (no auto space — user
        // 2026-07-10 item 5) is handled by the chip-boundary caret plugin
        // that ReferenceMention installs (reference-mention-caret.ts).
        // Gapcursor was the wrong tool: its valid() rejects textblock
        // parents, so it never fired inside the paragraph (batch-2 item 5).
        // Collaboration provides history (yUndo); do NOT add UndoRedo alongside.
        Collaboration.configure({ fragment }),
        // Remote collaborator carets (batch-2 item 14): mounted only when the
        // canvas-space doc's awareness is available — the extension THROWS in
        // onCreate on a null provider, and before the socket's first connect
        // there is genuinely nothing to publish carets through.
        ...(caretProvider?.awareness && caretUser
          ? [
            CollaborationCaret.configure({
              provider: caretProvider,
              user: caretUser,
              // Receiver-side safe render: whitelisted hue → theme-adaptive
              // palette var; never inlines free-form remote color strings.
              // BOTH builders — the default selectionRender inlines the raw
              // remote color too (adversarial round-1 HIGH).
              render: renderCollabCaret,
              selectionRender: renderCollabSelection,
            }),
          ]
          : []),
        Placeholder.configure({ placeholder }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({
            getPool: () => poolRef.current,
            emptyLabel: mentionEmptyLabel,
          }),
          // The chip's text-reference hover resolves live content through the
          // same pool ref (spec §9.1).
          getPool: () => poolRef.current,
        }),
      ],
      immediatelyRender: false,
      // Report BOTH derived values on every editor change (create + update): the
      // backend-bound prompt text (execute gate — text chips substitute their
      // source content, so "@ a non-empty text node" alone is a valid prompt)
      // and the `@`-picked source ids (i2i subset). Remote collaborator edits
      // also fire onUpdate via y-prosemirror, so the container's mirrors stay
      // current for both local and remote changes.
      onCreate: ({ editor: e }) => {
        onTextChange(serializePromptText(e, poolRef.current));
        onAtMentionsChange(extractAtMentionedSourceIds(e.getJSON()));
      },
      onUpdate: ({ editor: e }) => {
        onTextChange(serializePromptText(e, poolRef.current));
        onAtMentionsChange(extractAtMentionedSourceIds(e.getJSON()));
      },
    },
    // Recreate the editor when the fragment OR a captured translated string
    // changes. placeholder + mentionEmptyLabel are baked into the extensions at
    // creation and never re-synced by useEditor (deps-gated), so an in-session
    // locale switch would otherwise leave them in the old language until the
    // panel reopened (adversarial round-2). Both change only on a locale switch
    // (rare); the reference POOL stays a live ref (poolRef) so frequent edge
    // add/remove never triggers a recreate. caretProvider flips null→provider
    // once on first socket connect (mounting the caret extension); caretUser is
    // memoized by the container so it never churns per render.
    [fragment, placeholder, mentionEmptyLabel, caretProvider, caretUser],
  );
  // Click-to-insert (reference rail → prompt, user 2026-07-10 item 8): expose a
  // narrow imperative handle rather than the raw editor, keeping TipTap
  // encapsulated (same boundary as the onTextChange / onAtMentionsChange
  // "report derived values up" contract).
  React.useImperativeHandle(
    ref,
    () => ({
      insertReference: (item: ReferenceRailItem): void => {
        if (!editor) return;
        const content = referenceMentionContent(item);
        // Focused → insert at the caret; unfocused (no live cursor) → append to
        // the end. The rail button preventDefaults mousedown so it never blurs.
        if (editor.isFocused) {
          editor.chain().insertContent(content).run();
        } else {
          editor.chain().focus('end').insertContent(content).run();
        }
      },
      serializePrompt: (): string | null =>
        editor ? serializePromptText(editor, poolRef.current) : null,
    }),
    [editor],
  );
  // Re-report the substituted prompt text when the POOL changes (round-2
  // adversarial): a text chip resolves its source node's content at
  // serialization time, and that content can change with NO prompt-document
  // edit (the user types into the text node on the canvas) — onUpdate never
  // fires, so the container's execute-gate mirror would stay stuck on the
  // stale substitution (an empty node @-ed keeps the button dead after the
  // node gains words; an emptied node leaves the button lit but dead).
  React.useEffect(() => {
    if (!editor) return;
    onTextChange(serializePromptText(editor, references));
  }, [editor, references, onTextChange]);

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
  // t2i greys out existing IMAGE @-mention chips (design §2.4 C): the mode
  // switch visually pre-announces they will not take effect (execute forces
  // referenceUrls=[] in t2i). TEXT chips stay full-strength — their
  // substitution still feeds the prompt string and the submitted payload in
  // every mode (round-2 adversarial: dimming them lied about their effect).
  const dimReferences =
    mode === 't2i'
      ? ' [&_.reference-mention[data-kind=image]]:opacity-40 [&_.reference-mention[data-kind=image]]:grayscale'
      : '';
  return (
    <EditorContent
      editor={editor}
      data-testid='generate-prompt-editor'
      className={
        'nowheel max-h-40 min-h-[3.5rem] overflow-auto rounded-overlay border border-border bg-background px-2.5 py-2 text-sm text-foreground transition-colors focus-within:border-active-border [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-track]:bg-transparent [&_.ProseMirror]:min-h-[2.5rem] [&_.ProseMirror]:outline-none [&_p.is-editor-empty:first-child::before]:pointer-events-none [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:text-muted-foreground [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]' +
        dimReferences
      }
    />
  );
});
