// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { NodeHeader } from '@web/spaces/canvas/nodes/_shared/NodeHeader';
import { NodeShell } from '@web/spaces/canvas/nodes/_shared/NodeShell';
import type {
  DisplayStatus,
  Modality,
} from '@web/spaces/canvas/types/node-view';

interface ContentNodeFrameProps {
  /** Modality, selecting the header icon + fixed-English label fallback. */
  modality: Modality;
  /** Current node name (blank → modality label). */
  name?: string;
  status?: DisplayStatus;
  selected?: boolean;
  locked?: boolean;
  /** Commit a rename — pre-bound to this node's id by the ReactFlow wrapper. */
  onRename?: (name: string) => void;
  /** Extra classes for the shell (per-modality sizing). */
  className?: string;
  /** Stable test id for the shell root, per type node. */
  testId?: string;
  /** The modality body rendered inside the shell. */
  children: React.ReactNode;
}

/**
 * Shared frame for the 6 content modalities: the always-on name header
 * (icon + editable name, fixed size, left-aligned) above the node body
 * shell. Extracted so every content node composes the header + shell the
 * same way and the rename plumbing lives in one place. The annotation
 * sticky (its own header) and the group container do not use this frame.
 *
 * Renaming is read-only while the node is locked, matching the inline-edit
 * gate on the body. (Canvas-wide viewer-role read-only is a separate, not
 * yet plumbed, concern — there is no role context in the canvas body.)
 * @param root0 - Content node frame props.
 * @param root0.modality - Node modality, selecting the header icon + label.
 * @param root0.name - Current node name (blank → modality label fallback).
 * @param root0.status - Node status, tinting the shell's 1px state border.
 * @param root0.selected - Whether the node is selected, tinting the shell border.
 * @param root0.locked - Whether the node is locked (lock indicator + read-only name).
 * @param root0.onRename - Commit a rename, pre-bound to this node's id.
 * @param root0.className - Extra classes merged onto the shell (sizing).
 * @param root0.testId - Stable test id for the shell root.
 * @param root0.children - The modality body rendered inside the shell.
 * @returns The header-over-shell content node frame.
 */
export function ContentNodeFrame({
  modality,
  name,
  status,
  selected,
  locked,
  onRename,
  className,
  testId,
  children,
}: ContentNodeFrameProps): React.JSX.Element {
  return (
    <div className='flex flex-col gap-1'>
      <NodeHeader
        modality={modality}
        name={name}
        readOnly={locked}
        onRename={onRename}
      />
      <NodeShell
        status={status}
        selected={selected}
        locked={locked}
        className={className}
        testId={testId}
      >
        {children}
      </NodeShell>
    </div>
  );
}
