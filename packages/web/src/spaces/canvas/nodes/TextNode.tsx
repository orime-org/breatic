// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import type { TextNodeView } from '@web/spaces/canvas/types/node-view';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@web/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

interface TextNodeProps {
  data: TextNodeView;
  selected?: boolean;
  locked?: boolean;
  onActivate?: () => void;
  onChange?: (next: string) => void;
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
 * @returns The text node element (placeholder or inline-editable body).
 */
export function TextNode({
  data,
  selected,
  locked,
  onActivate,
  onChange,
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
    <NodeShell
      status={data.status}
      selected={selected}
      locked={locked}
      className='w-64'
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
            role='textbox'
            tabIndex={0}
            aria-multiline='true'
            aria-readonly={!editing}
            data-testid='text-node-body'
            contentEditable={editing}
            suppressContentEditableWarning
            onDoubleClick={startEdit}
            onBlur={commit}
            className='min-h-[3rem] whitespace-pre-wrap p-3 text-sm outline-none focus:bg-accent/30'
          >
            {data.content}
          </div>
        }
      />
    </NodeShell>
  );
}
