// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The editor a text node opens when somebody writes in it (#1774).
 *
 * Mounted only while editing, and that is not a detail. The caret extension
 * publishes into a single `cursor` field on the shared awareness, so two live
 * editors on one connection overwrite each other's caret — everyone would see
 * one collaborator at a time, in whichever node they touched last.
 *
 * Split out of the node body because the two have nothing to say to each other:
 * the body decides WHETHER writing is allowed and what the node looks like when
 * nobody is writing; this decides how a fragment becomes an editor. It also
 * gives the second-undo-stack guard something to call, which it cannot do for a
 * list assembled inline inside a component.
 */

import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import type { Extensions } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import * as React from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';

import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import type { CaretUserIdentity } from '@web/features/collab-editor/use-caret-user';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';

/**
 * The box metrics the two states of a text node's body MUST share.
 *
 * Exported and consumed by the display body as well, because "the same words
 * wrap the same way whether or not you are editing" is a promise nothing else
 * enforces: it used to be two hand-kept class strings in two files, and
 * changing the padding on one of them typechecked, passed the suite, and
 * silently broke the promise (round-6). One string, one place to change.
 *
 * All of them belong on the element the caret lives in, not on a wrapper. The
 * minimum height on a wrapper becomes dead space that does not take a click;
 * `outline-none` on a wrapper leaves the browser drawing its own ring on the
 * focused element, against the node frame's one-hairline rule; and the global
 * `box-sizing: border-box` makes the minimum include the padding, so one
 * element is 192px tall exactly like the display body — splitting them across
 * two elements would add a padding's worth of height on entering edit mode.
 *
 * Deliberately NO whitespace class. TipTap's own injected `.ProseMirror` rule
 * sets `white-space: break-spaces` on the editable element, and being unlayered
 * it beats anything Tailwind's layered utilities say — a whitespace class here
 * would be inert on the editor while real on the display, which is the one way
 * these two could still disagree. The display body declares
 * `whitespace-break-spaces` itself, to MATCH what the editor computes.
 */
export const TEXT_BODY_BOX =
  'min-h-48 break-words p-3 text-justify text-sm outline-none';

/**
 * The height the body is allowed to reach before it scrolls (edit) or clips
 * (display). Shared for the same reason as {@link TEXT_BODY_BOX}.
 */
export const TEXT_BODY_MAX_HEIGHT = 'max-h-144';

/**
 * The shared box plus what only the editable state wants: a contenteditable has
 * no cursor of its own, so without `cursor-text` it inherits the canvas grab
 * hand (user bug 2026-07-04), and `focus:` only ever matches the element that
 * actually receives focus.
 */
const EDITOR_CLASS = `${TEXT_BODY_BOX} cursor-text focus:bg-accent/30`;

/**
 * Build the text node editor's extension list.
 *
 * Exported so the second-undo-stack guard can call it. That guard exists
 * because `StarterKit` ships history on by default, and an editor carrying its
 * own history alongside collaboration gets two undo stacks — the local one
 * blind to who typed what, so one Cmd+Z deletes a collaborator's paragraph.
 * Nothing below can reach up and switch that off, so the check is external, and
 * it can only check lists it is able to call.
 *
 * Plain text on purpose: document, paragraph, text. No marks, no lists, no
 * StarterKit.
 * @param options - The fragment to bind and the caret wiring.
 * @param options.fragment - The node's shared body.
 * @param options.caretProvider - Provider carrying collaborator carets, or null before first connect.
 * @param options.caretUser - This user's caret identity.
 * @param options.collaboratorNames - Resolves collaborators' names from the roster.
 * @param options.placeholder - Text shown while the body is empty.
 * @returns The complete extension list.
 */
export function buildTextNodeExtensions(options: {
  fragment: Y.XmlFragment;
  caretProvider?: Pick<HocuspocusProvider, 'awareness'> | null;
  caretUser?: CaretUserIdentity | null;
  collaboratorNames?: CollaboratorNames | null;
  placeholder: string;
}): Extensions {
  const {
    fragment,
    caretProvider,
    caretUser,
    collaboratorNames,
    placeholder,
  } = options;
  return [
    Document,
    Paragraph,
    Text,
    // History, undo selection hand-off, caret refresh, and safely rendered
    // collaborator carets all arrive together from the shared layer. Carets
    // within it mount only once awareness exists: the extension throws on a
    // null provider, and before the socket's first connect there is nothing to
    // publish through.
    ...buildCollabExtensions({
      fragment,
      caretProvider,
      caretUser,
      resolveCollaboratorName: collaboratorNames?.resolve,
    }),
    Placeholder.configure({ placeholder }),
  ];
}

interface TextNodeEditorProps {
  /** The node's shared body. */
  fragment: Y.XmlFragment;
  /** Provider carrying collaborator carets, or null before the first connect. */
  caretProvider: Pick<HocuspocusProvider, 'awareness'> | null;
  /** This user's caret identity. */
  caretUser: CaretUserIdentity | null;
  /**
   * Names for the collaborators whose carets appear here, resolved from the
   * project member roster. Without it their carets are bare colour lines.
   */
  /** Text shown while the body is empty. */
  placeholder: string;
  /**
   * Whether this user may write. False builds a non-editable editor rather
   * than none: a viewer never gets this far (the body refuses to open one),
   * and this is the second lock on the same door.
   */
  editable: boolean;
  /**
   * Leave the editor, and why.
   *
   * Both exits are handled in here rather than on a wrapper, because both
   * belong to the thing being left: a keydown handler on a plain wrapping
   * element only fires for events that bubble out of the editor and asks the
   * reader to trust that none of them stop first, and a wrapper cannot see
   * focus leave at all.
   *
   * What is passed on is where focus should end up, not which event happened:
   * that is the only thing the exits differ in, and it is the only thing the
   * node above can act on. Escape is a request to go back to the node; a blur
   * means focus has already gone somewhere the user chose, and moving it again
   * would yank it out from under them.
   */
  onLeave: (focus: 'return-focus' | 'keep-focus') => void;
}

/**
 * The mounted editor for a text node's body.
 * @param props - The editor's inputs.
 * @param props.fragment - The node's shared body.
 * @param props.caretProvider - Provider carrying collaborator carets.
 * @param props.caretUser - This user's caret identity.
 * @param props.placeholder - Text shown while the body is empty.
 * @param props.editable - Whether this user may write.
 * @param props.onLeave - Leave the editor, saying where focus should end up.
 * @returns The editor element.
 */
export function TextNodeEditor({
  fragment,
  caretProvider,
  caretUser,
  placeholder,
  editable,
  onLeave,
}: TextNodeEditorProps): React.JSX.Element {
  // Read through a ref so the callback's IDENTITY never matters (round-5).
  // The handlers below live inside useEditor, whose dependency list rebuilds
  // the whole editor — and while somebody is typing, the parent re-renders on
  // every keystroke, so an inline-arrow `onLeave` in that list would tear the
  // editor down per key, yanking the caret and dropping IME composition. A
  // ref makes that impossible instead of documenting it as a rule callers
  // have to know.
  // From context, not from a prop: the roster is a project-level fact and
  // every layer between here and the project page used to have to forward it.
  const collaboratorNames = useCollaboratorNames();
  const onLeaveRef = React.useRef(onLeave);
  onLeaveRef.current = onLeave;
  const editor = useEditor(
    {
      extensions: buildTextNodeExtensions({
        fragment,
        caretProvider,
        caretUser,
        collaboratorNames,
        placeholder,
      }),
      editable,
      // Take the caret on mount. Nothing else will: this editor is not the
      // page's initial focus, and it appears in place of the element the
      // opening double-click was dispatched to — so without this, opening a
      // node hands back an editor nobody is typing into, and the next
      // keystroke goes to the canvas instead (Backspace there deletes the
      // node). At the end rather than the start, because a node is reopened to
      // keep writing far more often than to correct its first word.
      autofocus: 'end',
      // The editable element carries the body's test id, so display and edit
      // states are addressed the same way.
      //
      // The two ARIA attributes are not decoration and not new: the element
      // this replaced declared them, and a `contenteditable` div has no
      // implicit role to fall back on. Without them a screen reader announces
      // a group of text rather than a multi-line text box somebody is expected
      // to type into.
      editorProps: {
        attributes: {
          class: EDITOR_CLASS,
          'data-testid': 'text-node-body',
          role: 'textbox',
          'aria-multiline': 'true',
        },
        handleKeyDown: (_view, event): boolean => {
          if (event.key !== 'Escape') return false;
          onLeaveRef.current('return-focus');
          // Claimed, so nothing further up treats the same press as its own.
          return true;
        },
      },
      onBlur: ({ editor: instance, event }): void => {
        // Switching windows or tabs is not leaving the node: the whole
        // document loses focus, and coming back should find the caret where it
        // was rather than a node that closed itself while nobody was looking.
        if (!document.hasFocus()) return;
        // Focus moving to something inside the editor is not leaving either.
        const next = event.relatedTarget;
        if (next instanceof Node && instance.view.dom.contains(next)) return;
        onLeaveRef.current('keep-focus');
      },
      immediatelyRender: false,
    },
    // The placeholder is baked into the extensions at creation and never
    // re-synced, so a locale switch while a node is open would otherwise leave
    // the old language behind until it was reopened. `caretProvider` flips
    // from null to a provider once, on the socket's first connect.
    //
    // The RESOLVER, not the roster bundle around it: the bundle is a new object
    // on every project-page render, and listing it here rebuilt this editor
    // whenever anyone joined the project — the exact tear-down the ref above
    // exists to prevent. The resolver keeps one identity for the editor's whole
    // life and reads the current roster through a ref, so later names reach the
    // carets without the editor being recreated.
    [
      fragment,
      placeholder,
      caretProvider,
      caretUser,
      collaboratorNames?.resolve,
      editable,
    ],
  );
  // Publish this window's focus and dim collaborators who have left theirs.
  // The other half of the caret story: without it this client publishes into a
  // void, and renders a flag nobody sets.
  useCollabCaretPresence(editor, caretProvider, caretUser);

  return <EditorContent editor={editor} />;
}
