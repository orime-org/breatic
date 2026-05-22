import * as React from 'react';

import type { TextNodeData } from '@/spaces/canvas/types/node';
import { NodeShell } from '@/spaces/canvas/nodes/_shared/NodeShell';
import { NodeContent } from '@/spaces/canvas/nodes/_shared/NodeContent';
import { NodePlaceholder } from '@/spaces/canvas/nodes/_shared/NodePlaceholder';

interface TextNodeProps {
  data: TextNodeData;
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
 */
export function TextNode({
  data,
  selected,
  locked,
  onActivate,
  onChange,
}: TextNodeProps) {
  const [editing, setEditing] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const startEdit = () => {
    if (locked) return;
    setEditing(true);
    queueMicrotask(() => ref.current?.focus());
  };

  const commit = () => {
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
            className='min-h-[3rem] whitespace-pre-wrap p-3 text-sm outline-none focus:bg-muted/30'
          >
            {data.content}
          </div>
        }
      />
    </NodeShell>
  );
}
