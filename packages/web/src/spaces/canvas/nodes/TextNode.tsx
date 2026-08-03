// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type * as Y from 'yjs';

import { ScrollArea } from '@web/components/ui/scroll-area';
import { getTextBody, reseedTextBody } from '@web/data/yjs/canvas-space';
import { useTextBody } from '@web/data/yjs/use-text-body';
import { useTranslation } from '@web/i18n/use-translation';
import { useCanvasContext } from '@web/spaces/canvas/canvas-context';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import type { TextNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { TextNodeEditor } from '@web/spaces/canvas/nodes/TextNodeEditor';

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
  const { projectId, spaceId, readOnly, caretProvider, caretUser } =
    useCanvasContext();
  const text = useTextBody(projectId, spaceId, nodeId ?? '');
  // The open editor IS the fragment it is bound to. Holding a separate
  // "editing" boolean would let the two disagree, and the disagreeing state is
  // an editor bound to nothing.
  const [editedBody, setEditedBody] = React.useState<Y.XmlFragment | null>(null);
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
   * Leave edit mode. The text is already in the document — there is nothing to
   * commit, and nothing to discard.
   */
  const stopEdit = React.useCallback((): void => setEditedBody(null), []);

  /**
   * Open the editor on this node's body, unless something says no.
   *
   * Three gates, and they are not interchangeable. A viewer may not write at
   * all. A locked node is frozen by its owner, and a node a task is writing
   * would have that task's result overwritten — both of those tell the user
   * why, because a double-click that silently does nothing reads as a bug.
   *
   * A node with no body is repaired here rather than at render: repair is a
   * write, so it happens when somebody actually intends to write, and never
   * for a viewer.
   */
  const startEdit = React.useCallback((): void => {
    if (readOnly || !nodeId) return;
    const block = evaluateNodeGate(
      { locked: Boolean(locked), handling: data.status === 'handling' },
      'editContent',
    );
    if (block) {
      warnNodeGate(t(block.toastKey));
      return;
    }
    const fragment =
      getTextBody(projectId, spaceId, nodeId) ??
      reseedTextBody(projectId, spaceId, nodeId);
    if (fragment) setEditedBody(fragment);
  }, [readOnly, nodeId, locked, data.status, t, projectId, spaceId]);

  // A lock or a task can land WHILE somebody is writing. Close the editor when
  // it does — but what is already written stays: it reached the document as it
  // was typed, and throwing it away now would take a collaborator's words with
  // it. That is a real behaviour change from the commit-on-blur era, where the
  // uncommitted draft was simply dropped.
  React.useEffect(() => {
    if (editing && (locked || data.status !== 'idle')) stopEdit();
  }, [editing, locked, data.status, stopEdit]);

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
    const shell = document.querySelector(
      `.react-flow__node[data-id="${nodeId}"]`,
    );
    if (!(shell instanceof HTMLElement)) return undefined;
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
    // Re-run on the display/edit swap: with an editor open, Enter belongs to
    // the text.
  }, [nodeId, editing]);

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
              <ScrollArea className='nowheel nodrag' viewportClassName='max-h-144'>
                <TextNodeEditor
                  fragment={editedBody}
                  caretProvider={caretProvider}
                  caretUser={caretUser}
                  placeholder={t('canvas.textNode.editorPlaceholder')}
                  editable={!readOnly}
                  onEscape={stopEdit}
                />
              </ScrollArea>
            ) : (
              <div
                ref={displayRef}
                data-testid='text-node-body'
                onDoubleClick={startEdit}
                className='max-h-144 min-h-48 overflow-hidden whitespace-pre-wrap break-words p-3 text-justify text-sm outline-none'
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
