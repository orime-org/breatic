// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import { Editor, EditorContent } from '@tiptap/react';
import * as React from 'react';
import type * as Y from 'yjs';
import { REFERENCE_KINDS, type ReferenceKind } from '@breatic/shared';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { useCanvasContext, useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { endKeptEditor, keptEditor } from '@web/spaces/canvas/kept-editors';
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
import { NO_MENTION_TOKENS, type MentionTokens } from '@web/spaces/canvas/generate/reference-urls';
import { makeReferenceSuggestion } from '@web/spaces/canvas/generate/reference-mention-suggestion';
import { planCascadeDeletion } from '@web/spaces/canvas/generate/reference-mention-whitespace';
import { useFocusReturn } from '@web/lib/use-focus-return';

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
   * chips substitute their source node's current content, media chips are
   * written as `tokens` says. Called at execute-click so a text node edited
   * since the last prompt keystroke still lands its latest words.
   * @param tokens - Media chips' words from the same snapshot as the lists
   *   the submit sends; the last rendered ones when absent.
   * @returns The backend prompt string, or null when the editor is not ready.
   */
  serializePrompt: (tokens?: MentionTokens) => string | null;
}


/**
 * The classes greying one kind of `@` chip. Written out whole per kind so the
 * stylesheet builder finds each class in the source.
 */
const DIM_CHIP: Readonly<Record<ReferenceKind, string>> = {
  image: ' [&_.reference-mention[data-kind=image]]:opacity-40 [&_.reference-mention[data-kind=image]]:grayscale',
  video: ' [&_.reference-mention[data-kind=video]]:opacity-40 [&_.reference-mention[data-kind=video]]:grayscale',
  audio: ' [&_.reference-mention[data-kind=audio]]:opacity-40 [&_.reference-mention[data-kind=audio]]:grayscale',
};
/**
 * What a kept editor reads from whichever component is showing it now. The
 * component that built it may have been taken down with a hidden canvas since,
 * so its handlers and extensions read through this rather than that
 * component's closure.
 */
interface PromptWiring {
  references: ReferenceRailItem[];
  referenceKinds: readonly ReferenceKind[];
  onFocus?: () => void;
  blockSeparator?: string;
  mentionTokens: MentionTokens;
  placeholder: string;
  onTextChange: (text: string) => void;
  onAtMentionsChange: (sourceIds: string[]) => void;
  /** Where the open `@` popup registers its refresh. */
  suggestionRefresh: { current: (() => void) | null };
}

/** Each kept editor's wiring, what it was built on, and whether the caret goes back into it when it is shown. */
const keptOf = new WeakMap<
  Editor,
  {
    wiring: PromptWiring;
    caretProvider: Pick<HocuspocusProvider, 'awareness'> | null;
    mentionEmptyLabel: string;
    mentionNoMatchLabel: string;
    resolveName: unknown;
    hadFocus: boolean;
    returning: boolean;
  }
>();

/** The key each prompt's editor is kept under, one per prompt fragment. */
const promptKeys = new WeakMap<Y.XmlFragment, string>();
let promptCount = 0;

/**
 * The key a prompt's editor is kept under.
 * @param fragment - The prompt.
 * @returns Its key, the same one every time.
 */
function promptKey(fragment: Y.XmlFragment): string {
  let key = promptKeys.get(fragment);
  if (key === undefined) {
    promptCount += 1;
    key = `prompt:${promptCount}`;
    promptKeys.set(fragment, key);
  }
  return key;
}

interface PromptEditorProps {
  /** The node's prompt Y.XmlFragment — the collaborative binding target. */
  fragment: Y.XmlFragment;
  /**
   * What tests reach for this editor by (#1960).
   *
   * A prop because the music modes mount TWO of these — a style brief and a
   * lyrics box — and one id on both makes every `getByTestId` on the panel
   * ambiguous, which fails a strict-mode locator rather than picking one.
   * Defaults to the prompt's own id, so the panels mounting one keep theirs.
   */
  testId?: string;
  /**
   * How tall the box opens before anything is typed (#1960).
   *
   * `full` is 6.5rem, the floor every prompt box has had since user 2026-07-12
   * P6. `half` is exactly half of it, for a box that asks for a line or two
   * rather than a passage — the music modes' style brief beside a lyrics box
   * holding a whole song. Both grow with what is typed and cap at the same
   * ceiling; this is where each starts.
   */
  startingHeight?: 'full' | 'half';
  /**
   * Called when the caret enters this box (#1960).
   *
   * A panel with two of these has to know which one the writer was last in:
   * the reference rail's insert button fires long after the caret left, and
   * with no answer it can only ever aim at one of them.
   */
  onFocus?: () => void;
  /**
   * What joins two blocks in the string this box hands to the model (#1960).
   *
   * The editor's schema has no hard break, so Enter is the only line the user
   * can make and it always splits a block. A prompt reads as prose and takes
   * TipTap's own default of a blank line; a lyrics box asks for lines, where
   * a blank line between every pair is not what was typed.
   */
  blockSeparator?: string;
  /**
   * How each picture, clip or track chip is written into the prompt the model
   * reads, by pool id (#2156, design §13.2). Absent, such chips add nothing.
   */
  mentionTokens?: MentionTokens;
  /**
   * Placeholder shown while the box is empty.
   *
   * Read live rather than baked in at creation, so a box whose state changes
   * what it asks for can hand over a different sentence without the editor
   * being rebuilt under it.
   */
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
   * Which kinds of `@` mention the active model's pool takes in this mode
   * (#2156) — a picture, clip or track chip of any other kind is inert and
   * greyed (design §2.4 C). The kinds rather than the mode itself: this is
   * the only thing the editor ever asked the mode, and every panel that
   * mounts it answers it its own way.
   */
  referenceKinds: readonly ReferenceKind[];
  /** Localized empty-state text for the `@` picker popup. */
  mentionEmptyLabel: string;
  /**
   * Localized text for "there IS something, your query filtered it out".
   * Separate from {@link PromptEditorProps.mentionEmptyLabel}: telling a user
   * whose typing narrowed a non-empty list that there is nothing would be a
   * lie (user 2026-08-19).
   */
  mentionNoMatchLabel: string;
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
 * sees keystrokes live (rich text + @-mentions arrive in slice 2). The editor
 * lives as long as the opening of the panel it was built in, not as long as
 * this component: a hidden Space takes the panel down and puts it back, and
 * the caret and the undo history are on the editor (inner#1235 A13). The
 * fragment is external Yjs data and is never destroyed here.
 * @param root0 - Component props.
 * @param root0.fragment - The prompt Y.XmlFragment to bind to.
 * @param root0.placeholder - Empty-state placeholder text.
 * @param root0.onTextChange - Receives the current plain-text prompt.
 * @param root0.onAtMentionsChange - Receives the `@`-picked source node ids.
 * @param root0.references - The current reference pool (the `@` picker options).
 * @param root0.referenceKinds - The kinds of `@` chip the pool takes; the rest are inert (greyed).
 * @param root0.mentionEmptyLabel - Localized text for "this mode has nothing to offer".
 * @param root0.mentionNoMatchLabel - Localized text for "your query matched none of them".
 * @param root0.caretProvider - Canvas-space doc provider whose awareness carries collaborator carets (null until connected).
 * @param root0.testId - What tests reach for this editor by.
 * @param root0.startingHeight - How tall the box opens before anything is typed.
 * @param root0.onFocus - Called when the caret enters this box.
 * @param root0.blockSeparator - What joins two blocks in the serialized string.
 * @param root0.mentionTokens - Each media chip's words in the serialized string, by pool id.
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
    referenceKinds,
    mentionEmptyLabel,
    mentionNoMatchLabel,
    caretProvider = null,
    testId = 'generate-prompt-editor',
    startingHeight = 'full',
    onFocus,
    blockSeparator,
    mentionTokens = NO_MENTION_TOKENS,
  }: PromptEditorProps,
  ref,
): React.JSX.Element {
  // From context, not from a prop: the roster is a project-level fact and every
  // layer between here and the project page used to have to forward it.
  const collaboratorNames = useCollaboratorNames();
  const { spaceId } = useCanvasContext();
  const sessionStore = useCanvasSessionStore();
  // Which opening of the panel this editor belongs to: a panel closed, or
  // replaced by another, ends it; a panel taken down with a hidden Space and
  // put back does not (inner#1235 A13).
  const panelSession = useCanvasSession((st) => st.panelSession);
  const panelOpen = useCanvasSession((st) => st.panelHostId !== null);
  const resolveName = collaboratorNames?.resolve;
  const editor = React.useMemo((): Editor => {
    const key = promptKey(fragment);
    /**
     * Builds the editor, with its handlers reading the wiring box.
     * @returns The editor.
     */
    const build = (): Editor => {
      const wiring: PromptWiring = {
        references,
        referenceKinds,
        onFocus,
        blockSeparator,
        mentionTokens,
        placeholder,
        onTextChange,
        onAtMentionsChange,
        suggestionRefresh: { current: null },
      };
      /**
       * Reports both derived values: the backend-bound prompt text (execute
       * gate — text chips substitute their source content, so "@ a non-empty
       * text node" alone is a valid prompt) and the `@`-picked source ids (i2i
       * subset). Remote collaborator edits also arrive as updates through
       * y-prosemirror, so the container's mirrors follow both.
       * @param e - The editor.
       */
      const report = (e: Editor): void => {
        wiring.onTextChange(
          serializePromptText(e, wiring.references, wiring.blockSeparator, wiring.mentionTokens),
        );
        wiring.onAtMentionsChange(extractAtMentionedSourceIds(e.getJSON()));
      };
      const built = new Editor({
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
            resolveCollaboratorName: resolveName,
          }),
          // A function rather than a string: the sentence changes with the mode
          // and the extension is baked in at creation, so it reads the wiring
          // every time the view republishes (see the setEditable effect below).
          Placeholder.configure({
            placeholder: () => wiring.placeholder,
          }),
          ReferenceMention.configure({
            suggestion: makeReferenceSuggestion({
              getPool: () => wiring.references,
              emptyLabel: mentionEmptyLabel,
              noMatchLabel: mentionNoMatchLabel,
              // Same verdict as the rail's insert button, from the same call:
              // a row the picker offers is a row the rail would insert.
              getUsabilityContext: () => ({
                referenceKinds: wiring.referenceKinds,
                // Always true here: BOTH containers render a line of copy in
                // place of this editor when the model consumes no prompt
                // (#1966), so there is no `@` picker to open in that state.
                takesPrompt: true,
              }),
              refreshRef: wiring.suggestionRefresh,
            }),
            // The chip's text-reference hover resolves live content through the
            // same pool (spec §9.1).
            getPool: () => wiring.references,
          }),
        ],
        onCreate: ({ editor: e }) => report(e),
        onUpdate: ({ editor: e }) => report(e),
        onFocus: () => wiring.onFocus?.(),
      });
      keptOf.set(built, {
        wiring,
        caretProvider,
        mentionEmptyLabel,
        mentionNoMatchLabel,
        resolveName,
        hadFocus: false,
        returning: false,
      });
      // Ends with the opening of the panel it was built in.
      const session = sessionStore.getState().panelSession;
      const hostOpen = sessionStore.getState().panelHostId !== null;
      const stop = sessionStore.subscribe((st) => {
        if (st.panelSession === session && (st.panelHostId !== null) === hostOpen) return;
        stop();
        if (!built.isDestroyed) endKeptEditor(spaceId, key);
      });
      return built;
    };
    // A kept editor is reused while it is bound to the same caret connection
    // with the same captured strings (the key is the prompt's own). The two mention labels are
    // baked into the extensions and change only on a locale switch; the caret
    // connection arrives once, on the socket's first connect; the name
    // RESOLVER keeps one identity for the editor's whole life and reads the
    // current roster itself, so it is compared rather than the roster bundle,
    // which is rebuilt on every project-page render.
    return keptEditor(spaceId, key, build, (kept) => {
      const bound = keptOf.get(kept);
      return (
        bound?.caretProvider === caretProvider &&
        bound.mentionEmptyLabel === mentionEmptyLabel &&
        bound.mentionNoMatchLabel === mentionNoMatchLabel &&
        bound.resolveName === resolveName
      );
    });
    // Everything else reaches a kept editor through its wiring below, not by
    // rebuilding it. The panel's session and openness are listed so that a
    // panel ending under a mounted editor builds this one a new editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, fragment, caretProvider, mentionEmptyLabel, mentionNoMatchLabel, resolveName, panelSession, panelOpen]);

  const kept = keptOf.get(editor);
  if (kept !== undefined) {
    Object.assign(kept.wiring, {
      references,
      referenceKinds,
      onFocus,
      blockSeparator,
      mentionTokens,
      placeholder,
      onTextChange,
      onAtMentionsChange,
    });
  }
  // Back on screen after a switch of Space, the caret goes back in if it was
  // here when the Space was hidden. Kept with the editor, so a return still
  // waiting when the canvas library takes its panels down once more right
  // after showing them is carried to the next mount.
  useFocusReturn(
    keptOf.get(editor),
    () => !editor.isDestroyed && editor.view.hasFocus(),
    () => {
      if (!editor.isDestroyed) editor.view.focus();
    },
  );
  // A kept editor shown again reported its values when it was built, to
  // whichever container showed it then; this one has to hear them too.
  React.useEffect(() => {
    if (editor.isDestroyed) return;
    onAtMentionsChange(extractAtMentionedSourceIds(editor.getJSON()));
  }, [editor, onAtMentionsChange]);
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
        if (editor.isDestroyed) return;
        const content = referenceMentionContent(item);
        // Focused → insert at the caret; unfocused (no live cursor) → append to
        // the end. The rail button preventDefaults mousedown so it never blurs.
        if (editor.isFocused) {
          editor.chain().insertContent(content).run();
        } else {
          editor.chain().focus('end').insertContent(content).run();
        }
      },
      serializePrompt: (tokens?: MentionTokens): string | null =>
        editor.isDestroyed
          ? null
          : serializePromptText(
            editor,
            references,
            blockSeparator,
            tokens ?? mentionTokens,
          ),
    }),
    [editor, references, blockSeparator, mentionTokens],
  );
  // Re-report the substituted prompt text when the POOL changes (round-2
  // adversarial): a text chip resolves its source node's content at
  // serialization time, and that content can change with NO prompt-document
  // edit (the user types into the text node on the canvas) — onUpdate never
  // fires, so the container's execute-gate mirror would stay stuck on the
  // stale substitution (an empty node @-ed keeps the button dead after the
  // node gains words; an emptied node leaves the button lit but dead). A media
  // chip's words move the same way: mentioning a second picture or switching
  // model renumbers them with no edit to this chip.
  React.useEffect(() => {
    if (editor.isDestroyed) return;
    onTextChange(
      serializePromptText(editor, references, blockSeparator, mentionTokens),
    );
  }, [editor, references, blockSeparator, mentionTokens, onTextChange]);

  // Refresh an OPEN `@` popup's list when the mode or pool changes (collaboration
  // residual 2): a REMOTE peer toggling this node's mode or editing its
  // references updates `referenceKinds` / `references` here but fires NO
  // prompt-doc transaction, so @tiptap/suggestion never re-runs items() and a VISIBLE popup
  // keeps its pre-change list. The popup registers a refresh() (a no-op while
  // hidden) that recomputes its content from the live pool + mode. A LOCAL mode
  // change hides the popup first (clicking the picker), so this only bites the
  // remote case.
  React.useEffect(() => {
    keptOf.get(editor)?.wiring.suggestionRefresh.current?.();
  }, [editor, referenceKinds, references]);

  // Cascade-clear stale @-mention chips: when a reference edge is removed the
  // pool shrinks, so any @-mention pointing at a now-disconnected source must
  // disappear from the prompt (design §2.1 — a mention only picks from the
  // pool). Collect the mention occurrences, plan the deletions purely, then
  // apply them in one transaction (synced to collaborators via Collaboration).
  React.useEffect(() => {
    if (editor.isDestroyed) return;
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
    if (editor.isDestroyed) return;
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
  // Kept in step here rather than passed at creation: the editor's options are
  // read once when it is built, and rebuilding it for this would take the
  // collaborative binding and the caret down with it.
  //
  // `emitUpdate` off: it defaults to true, and the handler it would fire
  // re-serializes the prompt and re-walks the document for `@` mentions — work
  // `onCreate` has already done, on every mount of every panel's editor.
  //
  // `placeholder` is the dependency because this call is what republishes it:
  // `setEditable` goes through `setOptions`, which ends in `view.updateState`,
  // and that is when the extension re-reads the function behind the
  // placeholder. Without it the box would keep the sentence it was created
  // with until the next keystroke.
  React.useEffect(() => {
    if (!editor.isDestroyed) editor.setEditable(true, false);
  }, [editor, placeholder]);
  // A chip of a kind the pool does not take is greyed (design §2.4 C): a mode
  // or model switch visually pre-announces it will not take effect, since the
  // payload sends only the kinds the pool takes. TEXT chips stay
  // full-strength — their substitution feeds the prompt string, and this
  // signal is about references (round-2 adversarial: dimming them lied about
  // their effect).
  // A mode whose model declares no prompt sends an empty one (#1950), but it
  // mounts no editor either, so no chip is on screen to dim.
  const dimReferences = REFERENCE_KINDS.filter((kind) => !referenceKinds.includes(kind))
    .map((kind) => DIM_CHIP[kind])
    .join('');
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
      data-testid={testId}
      className={
        // `prompt-editor` is what index.css reaches for: the test id is a prop
        // now (#1960), and a rule keyed on one instance's id leaves every other
        // instance without it.
        'prompt-editor nowheel rounded-overlay border border-border bg-background text-sm text-foreground transition-colors focus-within:border-active-border'
      }
      viewportClassName={
        // `full` opens at 6.5rem (user 2026-07-12 P6): the panel opened at ~2
        // lines, which felt cramped for a prompt. `half` opens at half of that,
        // for a box asking for a line or two beside one holding a whole song
        // (#1960). Both cap at max-h-40 and scroll past their floor.
        // ProseMirror's own min-h carries the floor so the empty editor renders
        // at its height, not just the placeholder line.
        // Original symmetric padding (D, user 2026-07-12): the P3 top padding
        // (pt-5) that gave a first-line collaborator caret's above-label room is
        // reverted — the label now FLIPS below the caret on the first line
        // (caret-render.ts + .collaboration-carets__label--below), so no extra
        // top gap is needed and the prompt keeps its original edges.
        // The placeholder itself is drawn by a rule in index.css, shared with
        // every other editor that installs the extension.
        // Half states its floor once, on ProseMirror alone: the viewport's own
        // min-height measures the border box, so an outer floor below
        // `content + py-2` never binds. 2.25 + the 1rem of py-2 = 3.25rem,
        // exactly half of full's 6.5rem.
        (startingHeight === 'half'
          ? '[&_.ProseMirror]:min-h-[2.25rem] '
          : 'min-h-[6.5rem] [&_.ProseMirror]:min-h-[5.25rem] ') +
        'max-h-40 px-2.5 py-2 [&_.ProseMirror]:outline-none' +
        dimReferences
      }
    >
      <EditorContent editor={editor} />
    </ScrollArea>
  );
});
