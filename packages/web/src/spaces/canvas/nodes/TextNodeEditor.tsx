// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { Editor, EditorContent } from '@tiptap/react';
import * as React from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type * as Y from 'yjs';

import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { useCollabCaretPresence } from '@web/features/collab-editor/use-collab-caret-presence';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { keptEditor } from '@web/spaces/canvas/kept-editors';
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
  'min-h-48 break-words p-3 text-sm outline-none';

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
 * @param options.collaboratorNames - Resolves collaborators' names from the roster.
 * @param options.placeholder - Text shown while the body is empty, or what
 *   reads it when it can change for an editor that is kept.
 * @returns The complete extension list.
 */
export function buildTextNodeExtensions(options: {
  fragment: Y.XmlFragment;
  caretProvider?: Pick<HocuspocusProvider, 'awareness'> | null;
  collaboratorNames?: CollaboratorNames | null;
  placeholder: string | (() => string);
}): Extensions {
  const { fragment, caretProvider, collaboratorNames, placeholder } = options;
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
      resolveCollaboratorName: collaboratorNames?.resolve,
    }),
    Placeholder.configure({ placeholder }),
  ];
}

interface TextNodeEditorProps {
  /** The Space the node is on. */
  spaceId: string;
  /** The node. */
  nodeId: string;
  /** The node's shared body. */
  fragment: Y.XmlFragment;
  /** Provider carrying collaborator carets, or null before the first connect. */
  caretProvider: Pick<HocuspocusProvider, 'awareness'> | null;
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
 * What a kept editor reads from whichever component is showing it now. The
 * component that built it may have been taken down with a hidden canvas
 * since, so its handlers read through this rather than through that
 * component's closure.
 */
interface EditorWiring {
  onLeave: (focus: 'return-focus' | 'keep-focus') => void;
  placeholder: string;
}

/** Each kept editor's wiring, and the body and caret connection it was built on. */
const wiringOf = new WeakMap<
  Editor,
  {
    wiring: EditorWiring;
    fragment: Y.XmlFragment;
    caretProvider: Pick<HocuspocusProvider, 'awareness'> | null;
  }
>();

/**
 * The editor for a text node's body, kept for as long as the node is being
 * written in (inner#1235 A13), so a hidden canvas comes back with the caret
 * and the undo history where they were.
 * @param props - The editor's inputs.
 * @param props.spaceId - The Space the node is on.
 * @param props.nodeId - The node.
 * @param props.fragment - The node's shared body.
 * @param props.caretProvider - Provider carrying collaborator carets.
 * @param props.placeholder - Text shown while the body is empty.
 * @param props.editable - Whether this user may write.
 * @param props.onLeave - Leave the editor, saying where focus should end up.
 * @returns The editor element.
 */
export function TextNodeEditor({
  spaceId,
  nodeId,
  fragment,
  caretProvider,
  placeholder,
  editable,
  onLeave,
}: TextNodeEditorProps): React.JSX.Element {
  // From context, not from a prop: the roster is a project-level fact and
  // every layer between here and the project page used to have to forward it.
  // The RESOLVER keeps one identity for the editor's whole life and reads the
  // current roster through a ref, so later names reach the carets.
  const collaboratorNames = useCollaboratorNames();
  const resolveName = collaboratorNames?.resolve;
  const editor = React.useMemo((): Editor => {
    /**
     * Builds the editor, with its handlers reading the wiring box.
     * @returns The editor.
     */
    const build = (): Editor => {
      const wiring: EditorWiring = { onLeave, placeholder };
      const built = new Editor({
        extensions: buildTextNodeExtensions({
          fragment,
          caretProvider,
          collaboratorNames,
          placeholder: () => wiring.placeholder,
        }),
        editable,
        // Take the caret on creation. Nothing else will: this editor is not
        // the page's initial focus, and it appears in place of the element the
        // opening double-click was dispatched to — so without this, opening a
        // node hands back an editor nobody is typing into, and the next
        // keystroke goes to the canvas instead (Backspace there deletes the
        // node). At the end rather than the start, because a node is reopened
        // to keep writing far more often than to correct its first word.
        autofocus: 'end',
        // The editable element carries the body's test id, so display and
        // edit states are addressed the same way.
        //
        // The two ARIA attributes are not decoration and not new: the element
        // this replaced declared them, and a `contenteditable` div has no
        // implicit role to fall back on.
        editorProps: {
          attributes: {
            class: EDITOR_CLASS,
            'data-testid': 'text-node-body',
            role: 'textbox',
            'aria-multiline': 'true',
          },
          handleKeyDown: (_view, event): boolean => {
            if (event.key !== 'Escape') return false;
            wiring.onLeave('return-focus');
            // Claimed, so nothing further up treats the same press as its own.
            return true;
          },
        },
        onBlur: ({ editor: instance, event }): void => {
          // Switching windows or tabs is not leaving the node: the whole
          // document loses focus, and coming back should find the caret where
          // it was rather than a node that closed itself while nobody was
          // looking.
          if (!document.hasFocus()) return;
          // Focus moving to something inside the editor is not leaving either.
          const next = event.relatedTarget;
          if (next instanceof Node && instance.view.dom.contains(next)) return;
          // Nor is the canvas being hidden by a switch of Space, and the reader
          // comes back to it. Hiding takes the editor off the page — its host
          // unmounts and moves it into a detached element — and Chrome fires
          // this blur while it is still attached, so whether it was taken off
          // is only known once the commit doing it has run.
          queueMicrotask(() => {
            const dom = instance.view.dom;
            if (instance.isDestroyed || !dom.isConnected) return;
            if (dom.checkVisibility?.() === false) return;
            wiring.onLeave('keep-focus');
          });
        },
      });
      wiringOf.set(built, { wiring, fragment, caretProvider });
      return built;
    };
    // A kept editor is reused while it is bound to the same body and the same
    // caret connection; a body replaced by a repair, or the connection's
    // first arrival, builds a new one.
    return keptEditor(spaceId, nodeId, build, (kept) => {
      const bound = wiringOf.get(kept);
      return bound?.fragment === fragment && bound.caretProvider === caretProvider;
    });
    // `onLeave`, `placeholder` and `editable` reach a kept editor below, not by
    // rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, nodeId, fragment, caretProvider, resolveName]);

  const bound = wiringOf.get(editor);
  if (bound !== undefined) {
    bound.wiring.onLeave = onLeave;
    bound.wiring.placeholder = placeholder;
  }
  React.useEffect(() => {
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);
  // Back on screen after a switch of Space, the caret goes back in: the reader
  // was writing here when they left. A task later, the way the editor's own
  // autofocus waits: a mount that is undone straight away (Strict Mode) moves
  // the editor out of the page, and focus put in before that would be lost
  // and read as the reader leaving.
  React.useEffect(() => {
    const id = window.setTimeout(() => {
      if (!editor.isDestroyed && !editor.view.hasFocus()) editor.view.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [editor]);
  // Publish this window's focus and dim collaborators who have left theirs.
  // The other half of the caret story: without it this client publishes into a
  // void, and renders a flag nobody sets.
  useCollabCaretPresence(editor, caretProvider);

  return <EditorContent editor={editor} />;
}
