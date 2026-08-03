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

/**
 * Classes for the editable element itself.
 *
 * All of them belong on the element the caret lives in, not on a wrapper. The
 * minimum height on a wrapper becomes dead space that does not take a click;
 * `outline-none` on a wrapper leaves the browser drawing its own ring on the
 * focused element, against the node frame's one-hairline rule; `focus:` only
 * ever matches the element that actually receives focus; and a contenteditable
 * has no cursor of its own, so without `cursor-text` it inherits the canvas
 * grab hand (user bug 2026-07-04).
 *
 * Both the minimum height and the padding sit here together on purpose. The
 * global `box-sizing: border-box` makes the minimum include the padding, so one
 * element is 192px tall exactly like the display body; splitting them across
 * two elements would add a padding's worth of height on entering edit mode.
 */
const EDITOR_CLASS =
  'min-h-48 whitespace-pre-wrap break-words p-3 text-justify text-sm outline-none cursor-text focus:bg-accent/30';

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
 * @param options.placeholder - Text shown while the body is empty.
 * @returns The complete extension list.
 */
export function buildTextNodeExtensions(options: {
  fragment: Y.XmlFragment;
  caretProvider?: Pick<HocuspocusProvider, 'awareness'> | null;
  caretUser?: CaretUserIdentity | null;
  placeholder: string;
}): Extensions {
  const { fragment, caretProvider, caretUser, placeholder } = options;
  return [
    Document,
    Paragraph,
    Text,
    // History, undo selection hand-off, caret refresh, and safely rendered
    // collaborator carets all arrive together from the shared layer. Carets
    // within it mount only once awareness exists: the extension throws on a
    // null provider, and before the socket's first connect there is nothing to
    // publish through.
    ...buildCollabExtensions({ fragment, caretProvider, caretUser }),
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
  /** Text shown while the body is empty. */
  placeholder: string;
  /**
   * Whether this user may write. False builds a non-editable editor rather
   * than none: a viewer never gets this far (the body refuses to open one),
   * and this is the second lock on the same door.
   */
  editable: boolean;
  /**
   * Leave the editor. Handled in here rather than on a wrapper, because
   * Escape belongs to the thing being escaped from: a keydown handler on a
   * plain wrapping element only fires for events that bubble out of the
   * editor, and asks the reader to trust that none of them stop first.
   */
  onEscape: () => void;
}

/**
 * The mounted editor for a text node's body.
 * @param props - The editor's inputs.
 * @param props.fragment - The node's shared body.
 * @param props.caretProvider - Provider carrying collaborator carets.
 * @param props.caretUser - This user's caret identity.
 * @param props.placeholder - Text shown while the body is empty.
 * @param props.editable - Whether this user may write.
 * @param props.onEscape - Leave the editor.
 * @returns The editor element.
 */
export function TextNodeEditor({
  fragment,
  caretProvider,
  caretUser,
  placeholder,
  editable,
  onEscape,
}: TextNodeEditorProps): React.JSX.Element {
  const editor = useEditor(
    {
      extensions: buildTextNodeExtensions({
        fragment,
        caretProvider,
        caretUser,
        placeholder,
      }),
      editable,
      // The editable element carries the body's test id, so display and edit
      // states are addressed the same way.
      editorProps: {
        attributes: { class: EDITOR_CLASS, 'data-testid': 'text-node-body' },
        handleKeyDown: (_view, event): boolean => {
          if (event.key !== 'Escape') return false;
          onEscape();
          // Claimed, so nothing further up treats the same press as its own.
          return true;
        },
      },
      immediatelyRender: false,
    },
    // The placeholder is baked into the extensions at creation and never
    // re-synced, so a locale switch while a node is open would otherwise leave
    // the old language behind until it was reopened. `caretProvider` flips
    // from null to a provider once, on the socket's first connect.
    [fragment, placeholder, caretProvider, caretUser, editable, onEscape],
  );
  // Publish this window's focus and dim collaborators who have left theirs.
  // The other half of the caret story: without it this client publishes into a
  // void, and renders a flag nobody sets.
  useCollabCaretPresence(editor, caretProvider, caretUser);

  return <EditorContent editor={editor} />;
}
