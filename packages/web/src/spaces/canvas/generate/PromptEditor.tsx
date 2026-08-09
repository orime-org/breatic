// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import * as React from 'react';
import type * as Y from 'yjs';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';

import {
  extractAtMentionedSourceIds,
  planMentionDeletions,
  planChipDisplayUpdates,
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
  type MentionOccurrence,
  type ChipDisplaySnapshot,
} from '@web/spaces/canvas/generate/at-reference';
import type { ReferenceRailItem } from '@web/spaces/canvas/generate/derive-references';
import {
  MENTION_LABEL_ATTR,
  MENTION_THUMBNAIL_ATTR,
  ReferenceMention,
  referenceMentionContent,
  serializePromptText,
} from '@web/spaces/canvas/generate/reference-mention';
import { dispatchMachineEdit } from '@web/spaces/canvas/generate/reference-mention-local-input';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { planCascadeDeletion } from '@web/spaces/canvas/generate/reference-mention-whitespace';

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
  /**
   * Whether image `@` mentions are inert for the current generation mode —
   * image-to-image sources are ignored under text-to-image (design §2.4 C).
   * A boolean rather than the mode itself: this is the only thing the editor
   * ever asked the mode, and every panel that mounts it answers it its own way.
   */
  imageRefsDisabled: boolean;
  /** Localized empty-state text for the `@` picker popup. */
  mentionEmptyLabel: string;
  /**
   * The canvas-space doc's provider (its awareness carries collaborator
   * carets — batch-2 item 14). Null until the socket connects; the caret
   * extension mounts only when present (it throws on a null provider).
   */
  caretProvider?: Pick<HocuspocusProvider, 'awareness'> | null;
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
 * @param root0.imageRefsDisabled - Whether image `@` chips are inert (greyed).
 * @param root0.mentionEmptyLabel - Localized empty-state text for the `@` popup.
 * @param root0.caretProvider - Canvas-space doc provider whose awareness carries collaborator carets (null until connected).
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
    imageRefsDisabled,
    mentionEmptyLabel,
    caretProvider = null,
  }: PromptEditorProps,
  ref,
): React.JSX.Element {
  // From context, not from a prop: the roster is a project-level fact and every
  // layer between here and the project page used to have to forward it.
  const collaboratorNames = useCollaboratorNames();
  // The reference pool changes as edges are added / removed, but the editor is
  // rebuilt only on `fragment` change. A ref keeps the `@` suggestion reading
  // the CURRENT pool without recreating the editor.
  const poolRef = React.useRef(references);
  poolRef.current = references;
  // Live flag ref (same pattern as poolRef): the `@` suggestion reads it to
  // exclude image references when they are inert, without rebuilding the
  // editor on a mode toggle.
  const imageRefsDisabledRef = React.useRef(imageRefsDisabled);
  imageRefsDisabledRef.current = imageRefsDisabled;
  // The open `@` popup registers a refresh() here (collaboration residual 2): a
  // REMOTE mode / pool change fires no editor transaction, so the visible popup's
  // list would stay stale. The effect below calls it when `mode` / `references`
  // change, refreshing a visible popup's content from the live pool + mode.
  const suggestionRefreshRef = React.useRef<(() => void) | null>(null);
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
        // The whole collaboration half — history binding, undo selection
        // hand-off, caret refresh, and safely-rendered collaborator carets —
        // comes from one place, shared with the document editor. Carets within
        // it mount only when awareness is available: the extension THROWS in
        // onCreate on a null provider, and before the socket's first connect
        // there is genuinely nothing to publish carets through.
        ...buildCollabExtensions({
          fragment,
          caretProvider,
          resolveCollaboratorName: collaboratorNames?.resolve,
        }),
        Placeholder.configure({ placeholder }),
        ReferenceMention.configure({
          suggestion: makeReferenceSuggestion({
            getPool: () => poolRef.current,
            emptyLabel: mentionEmptyLabel,
            // t2i ignores source images → exclude image refs from the `@` picker.
            imageRefsDisabled: () => imageRefsDisabledRef.current,
            refreshRef: suggestionRefreshRef,
          }),
          // The chip's text-reference hover resolves live content through the
          // same pool ref (spec §9.1).
          getPool: () => poolRef.current,
          // t2i → an image chip's hover preview greys out (unavailable).
          getImageRefsDisabled: () => imageRefsDisabledRef.current,
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
    // once on first socket connect (mounting the caret extension). The name
    // RESOLVER is listed rather than the roster bundle holding it — the bundle
    // is rebuilt on every project-page render and would tear this editor down
    // mid-keystroke, while the resolver keeps one identity for the editor's
    // whole life and reads the current roster through a ref. Listed at all so
    // that a resolver arriving after mount still reaches the extensions.
    [
      fragment,
      placeholder,
      mentionEmptyLabel,
      caretProvider,
      collaboratorNames?.resolve,
    ],
  );
  // Publish this window's focus and dim collaborators who have left theirs.
  // Shared with the document editor — both halves have to travel together,
  // or one side publishes into a void and the other renders a flag nobody
  // sets.
  useCollabCaretPresence(editor, caretProvider);
  // Click-to-insert (reference rail → prompt, user 2026-07-10 item 8): expose a
  // narrow imperative handle rather than the raw editor, keeping TipTap
  // encapsulated (same boundary as the onTextChange / onAtMentionsChange
  // "report derived values up" contract).
  React.useImperativeHandle(
    ref,
    () => ({
      insertReference: (item: ReferenceRailItem): void => {
        if (!editor || editor.isDestroyed) return;
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
    if (!editor || editor.isDestroyed) return;
    onTextChange(serializePromptText(editor, references));
  }, [editor, references, onTextChange]);

  // Refresh an OPEN `@` popup's list when the mode or pool changes (collaboration
  // residual 2): a REMOTE peer toggling this node's mode or editing its
  // references updates `mode` / `references` here but fires NO prompt-doc
  // transaction, so @tiptap/suggestion never re-runs items() and a VISIBLE popup
  // keeps its pre-change list. The popup registers a refresh() (a no-op while
  // hidden) that recomputes its content from the live pool + mode. A LOCAL mode
  // change hides the popup first (clicking the picker), so this only bites the
  // remote case.
  React.useEffect(() => {
    suggestionRefreshRef.current?.();
  }, [imageRefsDisabled, references]);

  // Cascade-clear stale @-mention chips: when a reference edge is removed the
  // pool shrinks, so any @-mention pointing at a now-disconnected source must
  // disappear from the prompt (design §2.1 — a mention only picks from the
  // pool). Collect the mention occurrences, plan the deletions purely, then
  // apply them in one transaction (synced to collaborators via Collaboration).
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
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
    // Delete each stale chip WITH its owned spaces (same deletion-unit model as
    // the keyboard path), so a cascade clear leaves NO orphan space — a space
    // shared with a SURVIVING chip is kept (design 2026-07-13 §5; adversarial
    // finding: the old chip-node-only delete left orphan spaces, diverging from
    // the keyboard path). Ranges are descending + merged, so each delete leaves
    // the remaining (lower) positions valid.
    const stalePositions = new Set(deletions.map((d) => d.from));
    const ranges = planCascadeDeletion(editor.state.doc, stalePositions);
    const tr = editor.state.tr;
    for (const { from, to } of ranges) tr.delete(from, to);
    // Edge-driven chip removal is a CONSEQUENCE of a canvas action, not a prompt
    // edit: dispatchMachineEdit keeps it out of the undo stack (Cmd+Z can't
    // resurrect an orphan chip whose reference is gone) AND tags it machine-
    // derived so the local-input tracker never counts it as a keystroke —
    // deleting a chip BEFORE an active `@` shifts its range and fires onUpdate,
    // which must not resurrect a dismissed popup (#1802 round-4; batch-4).
    dispatchMachineEdit(editor.view, tr);
  }, [editor, references]);

  // Keep every reference chip a LIVE PROJECTION of its source node's pool row —
  // for EVERY modality, not just images (design 2026-07-12 invariant; batch-5
  // I5). The chip's cheap synced display attrs (name + thumbnail) are frozen at
  // insert time, so a renamed / re-generated source must be re-synced here; the
  // pure planner diffs each chip against the live pool and reports only changed
  // fields (a text source has no thumbnail — its name still syncs, which the
  // old thumbnail-only effect missed). Setting an attr re-renders the
  // ReactNodeView. Chips whose source left the pool are removed by the
  // cascade-clear effect above (the planner skips them). The text chip's hover
  // CONTENT is not synced here — it is read live at hover-open (see
  // HoverPreview's resolveOnOpen), keeping the source node the single truth
  // (freezing the body into an attr would duplicate it into the Yjs prompt doc).
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const chips: ChipDisplaySnapshot[] = [];
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name !== REFERENCE_MENTION_NODE) return;
      const id: unknown = n.attrs[MENTION_SOURCE_ID_ATTR];
      if (typeof id !== 'string') return;
      chips.push({
        pos,
        sourceNodeId: id,
        label: (n.attrs[MENTION_LABEL_ATTR] as string | null) ?? null,
        thumbnail: (n.attrs[MENTION_THUMBNAIL_ATTR] as string | null) ?? null,
      });
    });
    const updates = planChipDisplayUpdates(chips, references);
    if (updates.length === 0) return;
    const tr = editor.state.tr;
    for (const u of updates) {
      if ('label' in u) {
        tr.setNodeAttribute(u.pos, MENTION_LABEL_ATTR, u.label ?? null);
      }
      if ('thumbnail' in u) {
        tr.setNodeAttribute(u.pos, MENTION_THUMBNAIL_ATTR, u.thumbnail ?? null);
      }
    }
    // Machine-derived cosmetic sync: dispatchMachineEdit keeps it OUT of the
    // collaborative undo stack (else Cmd+Z reverts a name / thumbnail refresh
    // instead of the user's own edit, and — gated on `references`, not the doc —
    // that revert never self-heals) AND tags it so the local-input tracker never
    // counts it as a keystroke (#1802 round-4; batch-4).
    dispatchMachineEdit(editor.view, tr);
  }, [editor, references]);
  // t2i greys out existing IMAGE @-mention chips (design §2.4 C): the mode
  // switch visually pre-announces they will not take effect (execute forces
  // referenceUrls=[] in t2i). TEXT chips stay full-strength — their
  // substitution still feeds the prompt string and the submitted payload in
  // every mode (round-2 adversarial: dimming them lied about their effect).
  const dimReferences = imageRefsDisabled
    ? ' [&_.reference-mention[data-kind=image]]:opacity-40 [&_.reference-mention[data-kind=image]]:grayscale'
    : '';
  return (
    // ScrollArea (#1773): the prompt scrolls behind a custom OVERLAY scrollbar
    // (appears only while scrolling, no layout space, hover changes color
    // only) — native scrollbars can't deliver that combination. The Radix
    // VIEWPORT is the actual scroller, so the line caps (min 4 lines /
    // max-h-40) and the content padding live on it (padding must scroll with
    // the content); the chrome (border, bg, focus ring) stays on the root.
    // The testid stays on the root because that is where tests reach for the
    // whole control. The caret label flip no longer measures against it — it
    // finds the Radix viewport itself (caret-render.ts), which is the element
    // that actually clips and works for every editor, not just this one.
    <ScrollArea
      data-testid='generate-prompt-editor'
      className='nowheel rounded-overlay border border-border bg-background text-sm text-foreground transition-colors focus-within:border-active-border'
      viewportClassName={
        // min height = 4 text-sm lines (user 2026-07-12 P6): the panel opened at
        // ~2 lines which felt cramped for a prompt. The viewport holds 4 lines of
        // ProseMirror content plus its py-2, and still caps at max-h-40 (scrolls
        // past 4). ProseMirror's own min-h carries the 4-line floor so the empty
        // editor renders at full height, not just the placeholder line.
        // Original symmetric padding (D, user 2026-07-12): the P3 top padding
        // (pt-5) that gave a first-line collaborator caret's above-label room is
        // reverted — the label now FLIPS below the caret on the first line
        // (caret-render.ts + .collaboration-carets__label--below), so no extra
        // top gap is needed and the prompt keeps its original edges.
        // The placeholder itself is drawn by a rule in index.css, shared with
        // every other editor that installs the extension.
        'max-h-40 min-h-[6.5rem] px-2.5 py-2 [&_.ProseMirror]:min-h-[5.25rem] [&_.ProseMirror]:outline-none' +
        dimReferences
      }
    >
      <EditorContent editor={editor} />
    </ScrollArea>
  );
});
