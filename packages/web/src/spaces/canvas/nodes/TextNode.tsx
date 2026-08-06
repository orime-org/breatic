// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { ensureTextBody } from '@web/data/yjs/canvas-space';
import { useEditedTextBody, useTextBody } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { TextNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { useCanvasStore } from '@web/stores';
import {
  TEXT_BODY_BOX,
  TEXT_BODY_MAX_HEIGHT,
  TextNodeEditor,
} from '@web/spaces/canvas/nodes/TextNodeEditor';

/**
 * The ReactFlow wrapper element for a node id, or null when it is not mounted.
 *
 * Written once because two places need it — handing focus back on the way out
 * of the editor, and attaching the Enter listener — and it encodes how
 * ReactFlow stamps its wrappers. Two copies of that coupling would be free to
 * drift the day the selector or the id escaping has to change.
 * @param nodeId - The node whose wrapper to find.
 * @returns The wrapper element, or null.
 */
function nodeShell(nodeId: string): HTMLElement | null {
  const shell = document.querySelector(
    `.react-flow__node[data-id="${nodeId}"]`,
  );
  return shell instanceof HTMLElement ? shell : null;
}

interface TextNodeProps {
  data: TextNodeView;
  selected?: boolean;
  locked?: boolean;
  onRename?: (name: string) => void;
}

/**
 * Text node — the body people write in.
 *
 * The text is a shared fragment on the node, so two people typing merge
 * character by character. It is deliberately absent from the node view (which
 * is what keeps a keystroke from re-rendering the board), so it is subscribed
 * to here for display and handed to the editor to bind while editing.
 *
 * Editing is a swap, not a mode flag on one element: a non-editing body must
 * carry neither `contenteditable` (React renders even `={false}` as the literal
 * attribute, and ReactFlow's `isInputDOMNode` reads its presence, not its
 * value, then swallows Delete) nor a tabindex that would steal click focus from
 * node selection. Both would make a filled node undeletable (#260).
 * @param root0 - Text node props.
 * @param root0.data - The node view: name, status, error message.
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, which blocks writing.
 * @param root0.onRename - Commit a rename, pre-bound to this node's id.
 * @returns The text node element.
 */
export const TextNode = React.memo(function TextNode({
  data,
  selected,
  locked,
  onRename,
}: TextNodeProps): React.JSX.Element {
  const t = useTranslation();
  const nodeId = React.useContext(NodeIdContext);
  const { projectId, spaceId, readOnly, caretProvider } = useCanvasContext();
  const text = useTextBody(projectId, spaceId, nodeId ?? '');
  // The open editor IS the fragment it is bound to, and that fragment is
  // followed rather than snapshotted — see the hook for why a snapshot goes
  // silent when a concurrent repair replaces the node's body.
  const {
    body: editedBody,
    open: openEditor,
    close: closeEditor,
  } = useEditedTextBody(projectId, spaceId, nodeId ?? '');
  const editing = editedBody !== null;
  const displayRef = React.useRef<HTMLDivElement>(null);

  // Display state clips, so a bottom fade hints "there's more" — but only when
  // the content is actually clipped, never on short text. jsdom reports 0/0, so
  // the fade is a browser-only affordance and the tests assert the clip classes.
  const [clipped, setClipped] = React.useState(false);
  React.useLayoutEffect(() => {
    const el = displayRef.current;
    if (el) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, editing]);

  /**
   * Leave edit mode, saying where focus should end up.
   *
   * The text is already in the document, so there is nothing to commit and
   * nothing to discard. Focus is the only part that differs between the exits,
   * so that — not the key or event that triggered them — is what this asks
   * for. Naming the trigger instead would leave the third exit (a lock or a
   * task landing mid-edit) picking between two labels, neither of which is
   * what happened to it.
   *
   * `return-focus`: the element the caret was in is about to be unmounted, and
   * a browser left to itself drops focus on the document body — press Escape
   * and you lose your place on the board entirely. Handing it back to the node
   * wrapper puts you where you started, which is also where Enter reopens the
   * editor.
   *
   * `keep-focus`: focus has already gone where the user put it, and pulling it
   * back to this node would take it off whatever they just clicked.
   * @param focus - Where focus should be when this returns.
   */
  const leaveEdit = React.useCallback(
    (focus: 'return-focus' | 'keep-focus'): void => {
      closeEditor();
      if (focus === 'keep-focus' || !nodeId) return;
      nodeShell(nodeId)?.focus();
    },
    [closeEditor, nodeId],
  );

  // Whether this node can be written in, worked out ONCE and read by both the
  // way in and the way back out. Two hand-written conditions drift, and these
  // had: entry asked the shared gate — which knows only `locked` and
  // `handling` — while the exit closed on any status other than `idle`. On a
  // failed node they disagreed, so opening one repaired a missing body (a real
  // write into the shared document) and set edit state, both of which the exit
  // undid on the same tick. None of it was visible: the renderer gives a failed
  // node's content slot to the error message, so no editor is mounted there
  // either way. The write is what actually went away.
  //
  // Idle is required on top of the gate because the renderer says so: the
  // content slot shows a skeleton while a task writes and the error message
  // when one failed, so an editor opened in either state would be state with
  // nothing on screen. The gate stays the source of the *reason* — it is what
  // produces the toast — and this adds the one condition the gate has no
  // vocabulary for.
  //
  // Memoized for the ordinary reason: a blocked verdict is a fresh object on
  // every call, `startEdit` closes over it, and `startEdit` is handed to child
  // components. No effect reads this — they read the `canEdit` boolean below —
  // so the memo is about prop stability, not about re-running anything.
  const editBlock = React.useMemo(
    () =>
      evaluateNodeGate(
        { locked: Boolean(locked), handling: data.status === 'handling' },
        'editContent',
      ),
    [locked, data.status],
  );
  // `readOnly` is a third writability premise, IN the condition for the same
  // reason as the other two (round-5): the role is a live query, so an
  // editor→viewer downgrade can land mid-edit exactly like a lock or a task —
  // and when the first cut left it out, the exit below never closed on a
  // downgrade, leaving a viewer's ghost editor publishing their caret into
  // shared awareness.
  const canEdit = !readOnly && editBlock === null && data.status === 'idle';

  /**
   * Open the editor on this node's body, unless something says no.
   *
   * A viewer may not write at all. A locked node is frozen by its owner, and a
   * node a task is writing would have that task's result overwritten — both of
   * those say why, because a double-click that silently does nothing reads as
   * a bug. A failed node is the one refusal with nothing to say: it is already
   * showing the user its error where the body would be.
   *
   * A node with no body is repaired here rather than at render: repair is a
   * write, so it happens when somebody actually intends to write, and never
   * for a viewer.
   */
  const startEdit = React.useCallback((): void => {
    // Not the writability gate — `canEdit` below already covers `readOnly`.
    // This return is toast POLICY: a viewer double-clicking a locked node
    // should not be told "unlock it to edit" when unlocking would not let
    // them edit either, so their refusal stays silent and comes first.
    if (readOnly || !nodeId) return;
    // A running reference pick owns node interaction (user 2026-07-12 P2b), so
    // entering edit — a WRITE, since a bodyless node is repaired on the way in
    // — must not happen under one. The rule used to live on the wrapper's
    // double-click capture, which is a guard on one EVENT rather than on the
    // action: the keyboard doors this feature added (Enter on the node, Space
    // on an empty node's placeholder) walked straight past it while a
    // double-click was still stopped. Read fresh here, where the action is,
    // the same way `activateNodeUpload` does — then any future door is covered
    // by construction. Silent like the read-only refusal: the pick is what the
    // user is doing, and it is visibly in progress.
    if (useCanvasStore.getState().pickSession) return;
    if (editBlock) {
      warnNodeGate(t(editBlock.toastKey));
      return;
    }
    if (!canEdit) return;
    const fragment = ensureTextBody(projectId, spaceId, nodeId);
    if (fragment) openEditor(fragment);
  }, [readOnly, nodeId, editBlock, canEdit, t, projectId, spaceId, openEditor]);

  // A lock or a task can land WHILE somebody is writing. Close the editor when
  // it does — but what is already written stays: it reached the document as it
  // was typed, and throwing it away now would take a collaborator's words with
  // it. That is a real behaviour change from the commit-on-blur era, where the
  // uncommitted draft was simply dropped.
  //
  // Focus goes back to the node: the caret is inside an element about to be
  // unmounted, and nobody chose to leave — the node was taken away from them.
  React.useEffect(() => {
    if (editing && !canEdit) leaveEdit('return-focus');
  }, [editing, canEdit, leaveEdit]);

  // Keyboard entry, and it cannot be a handler on anything rendered here.
  //
  // ReactFlow's node wrapper is the tab stop (nodes are focusable by default),
  // and we must not add a second one — two tab stops per node makes Tab walk
  // the board twice. But a keypress on the wrapper never reaches its children:
  // the event's target IS the wrapper, and events travel outwards, not in. A
  // handler on the body below would only ever see keys pressed inside it, and
  // would look correct in a test that dispatches the event straight at it.
  //
  // So the listener goes on the wrapper itself, found by walking up from the
  // body. The target check keeps it to keys pressed on the wrapper — an Enter
  // typed inside the editor bubbles through here too, and must stay a newline.
  //
  // ReactFlow reads Enter as "select this node" (`elementSelectionKeys`), which
  // is complementary rather than conflicting: opening the editor on a node also
  // selects it. This runs first regardless — a native listener on the element
  // beats React's delegated handler at the root.
  const startEditRef = React.useRef(startEdit);
  startEditRef.current = startEdit;
  React.useEffect(() => {
    if (!nodeId) return undefined;
    // Found by id, not by walking up from the body — an empty node renders a
    // placeholder instead of a body, and a listener that needed the body would
    // never attach to exactly the nodes most in need of a way in. ReactFlow
    // stamps `data-id` on the wrapper it makes focusable, so this is the same
    // element either way.
    const shell = nodeShell(nodeId);
    if (!shell) return undefined;
    /**
     * Open the editor when Enter is pressed on the node itself.
     * @param event - The native keyboard event from the node wrapper.
     */
    const onShellKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || event.target !== shell) return;
      event.preventDefault();
      startEditRef.current();
    };
    shell.addEventListener('keydown', onShellKeyDown);
    return () => shell.removeEventListener('keydown', onShellKeyDown);
    // Attached for the node's whole life, editing or not. What keeps Enter a
    // newline while the editor is open is the target check above and nothing
    // else — an Enter typed in the editor bubbles out to the wrapper, but its
    // target is the editor, so it is let through untouched.
  }, [nodeId]);

  const hasContent = text.length > 0;

  return (
    <ContentNodeFrame
      modality='text'
      name={data.name}
      status={data.status}
      selected={selected}
      locked={locked}
      onRename={onRename}
      testId='text-node'
    >
      <NodeContent
        status={data.status}
        errorMessage={data.errorMessage}
        // While editing, show the editor even for an empty body — a fresh node
        // entered from the placeholder has nothing written yet.
        hasContent={hasContent || editing}
        placeholder={<NodePlaceholder modality='text' onActivate={startEdit} />}
        content={
          // Relative wrapper so the display fade can overlay the body's bottom
          // edge without affecting layout.
          <div className='relative'>
            {editing ? (
              // `nowheel` (the wheel scrolls the text being edited) and
              // `nodrag` (a pointer press selects text instead of dragging the
              // node) sit on the ScrollArea root — ReactFlow checks ancestors.
              // The height cap moves to the Radix viewport, the element that
              // actually scrolls.
              <ScrollArea className='nowheel nodrag' viewportClassName={TEXT_BODY_MAX_HEIGHT}>
                <TextNodeEditor
                  fragment={editedBody}
                  caretProvider={caretProvider}
                  placeholder={t('canvas.textNode.editorPlaceholder')}
                  editable={!readOnly}
                  onLeave={leaveEdit}
                />
              </ScrollArea>
            ) : (
              <div
                ref={displayRef}
                data-testid='text-node-body'
                onDoubleClick={startEdit}
                // Box metrics come from the editor's own constant, so the two
                // states cannot drift apart. What is added here is display-only:
                // the height cap with clipping (the editor scrolls instead), and
                // `break-spaces` — ProseMirror sets that on its editable element
                // and the two differ on whether a run of spaces at a line end
                // takes up room, so this declares the value the editor computes.
                className={`${TEXT_BODY_MAX_HEIGHT} ${TEXT_BODY_BOX} overflow-hidden whitespace-break-spaces`}
              >
                {text}
              </div>
            )}
            {!editing && clipped ? (
              <div
                data-testid='text-node-fade'
                aria-hidden='true'
                // The node shell clips children to its rounded box, so the fade
                // needs no radius of its own.
                className='pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent'
              />
            ) : null}
          </div>
        }
      />
    </ContentNodeFrame>
  );
});
