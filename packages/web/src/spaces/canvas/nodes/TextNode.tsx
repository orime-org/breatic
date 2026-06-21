// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { TextNodeView } from '@web/spaces/canvas/types/node-view';
import { ContentNodeFrame } from '@web/spaces/canvas/nodes/_shared/ContentNodeFrame';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface TextNodeProps {
  data: TextNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onChange?: (next: string) => void;
  onRename?: (name: string) => void;
}

/**
 * Text node — modality body that supports inline contenteditable
 * editing on double-click. State `idle` with no content shows the
 * placeholder; `handling` shows a skeleton; `error` shows the message.
 *
 * Generation behaviour (prompt + model + send) lives in the toolbar
 * left-zone popover (PR 7), not in this node body.
 * @param root0 - Text node props.
 * @param root0.data - Text node payload (content string, status, optional error message).
 * @param root0.selected - Whether the node is selected, driving the selection ring.
 * @param root0.locked - Whether the node is locked, blocking inline editing and showing the lock indicator.
 * @param root0.onActivate - Called from the empty-state placeholder to open the generate/load popover.
 * @param root0.onChange - Called with the new text when an inline edit is committed on blur.
 * @param root0.onRename - Commit a rename of this node's name (pre-bound to the node id by the canvas).
 * @returns The text node element (placeholder or inline-editable body).
 */
export function TextNode({
  data,
  selected,
  locked,
  onActivate,
  onChange,
  onRename,
}: TextNodeProps): React.JSX.Element {
  const [editing, setEditing] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  /**
   * Enters inline edit mode (unless the node is locked) and focuses the
   * contenteditable body on the next microtask.
   */
  const startEdit = (): void => {
    if (locked) return;
    setEditing(true);
    queueMicrotask(() => ref.current?.focus());
  };

  /**
   * Commits the edited text to the caller via `onChange` and leaves edit
   * mode.
   */
  const commit = (): void => {
    if (ref.current && onChange) onChange(ref.current.innerText);
    setEditing(false);
  };

  const hasContent = data.content.length > 0;

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
        hasContent={hasContent}
        placeholder={
          <NodePlaceholder modality='text' onActivate={onActivate} />
        }
        content={
          <div
            ref={ref}
            data-testid='text-node-body'
            // Editable affordances are mounted ONLY while editing. A non-editing
            // body must carry neither `contenteditable` (React renders even
            // `={false}` as the literal attribute `contenteditable="false"`) nor
            // a tabindex: ReactFlow's isInputDOMNode flags ANY element that has a
            // `contenteditable` attribute as an input — the value is ignored —
            // and swallows the Delete key, while a focusable body steals the
            // click focus from node selection. Either one blocks deleting a
            // content-filled text node, so both are gated behind `editing`.
            role={editing ? 'textbox' : undefined}
            tabIndex={editing ? 0 : undefined}
            aria-multiline={editing ? 'true' : undefined}
            contentEditable={editing || undefined}
            suppressContentEditableWarning
            onDoubleClick={startEdit}
            onBlur={commit}
            // While editing, `nodrag` lets a pointer press select text instead
            // of dragging the node; when not editing, the body stays a drag
            // handle so the node can be moved by its content.
            //
            // Both states cap at 576px (`max-h-144` = width 288 × 2) and scroll
            // past it (`overflow-y-auto`) — no `line-clamp` ellipsis: the user
            // reads the full text by scrolling (double-click edits), with a slim
            // neutral custom scrollbar instead of the OS default (#5).
            className={`${
              editing ? 'nodrag ' : ''
            }max-h-144 overflow-y-auto min-h-[3rem] whitespace-pre-wrap p-3 text-sm outline-none focus:bg-accent/30 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-track]:bg-transparent`}
          >
            {data.content}
          </div>
        }
      />
    </ContentNodeFrame>
  );
}
