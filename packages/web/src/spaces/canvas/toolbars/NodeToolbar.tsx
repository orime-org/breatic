// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';

import { Separator } from '@web/components/ui/separator';
import { cn } from '@web/lib/utils';
import type { Modality } from '@web/spaces/canvas/types/node-view';

import { NodeGeneratePopover } from '@web/spaces/canvas/toolbars/NodeGeneratePopover';
import { NodeLoadButton } from '@web/spaces/canvas/toolbars/NodeLoadButton';
import { MiniToolPicker } from '@web/spaces/canvas/toolbars/MiniToolPicker';

interface NodeToolbarProps {
  nodeId: string;
  modality: Modality;
  /** Generate handler — runs the AI prompt against this node in place. */
  onGenerate?: (prompt: string, model: string) => void;
  /** Load handler — replaces the node's content with a file payload. */
  onLoad?: (file: File) => void;
  /** Mini-tool selection — creates a new sibling node + primary edge. */
  onPickMiniTool?: (toolId: string) => void;
  /** Show the toolbar at all (visible on node hover / selection). */
  visible?: boolean;
}

/**
 * Two-zone toolbar that floats above the active canvas node:
 *
 *   ┌──────────────────────────────┐
 *   │ [generate]  [load]  │  [mini-tool ▾] │
 *   └──────────────────────────────┘
 *
 * Behaviour contract:
 *   - Left zone (generate + load) modifies the CURRENT node in place.
 *     Generate opens a popover (prompt + model + send); load is a file
 *     picker.
 *   - Right zone (mini-tool) creates a NEW sibling node + primary edge.
 *     Selecting a tool delegates to `pages/project/mini-tool-system`.
 *
 * The vertical separator keeps the two intents visually distinct so
 * users never confuse "edit this node" with "branch a new node."
 * @param root0 - Node toolbar props.
 * @param root0.nodeId - ID of the node this toolbar acts on, stamped on the root for selectors.
 * @param root0.modality - Node modality, forwarded to the generate / load / mini-tool controls.
 * @param root0.onGenerate - Generate handler that runs the AI prompt against this node in place.
 * @param root0.onLoad - Load handler that replaces the node's content with a file payload.
 * @param root0.onPickMiniTool - Mini-tool selection handler that creates a new sibling node + primary edge.
 * @param root0.visible - Whether the toolbar is shown (on node hover / selection).
 * @returns The floating two-zone node toolbar element.
 */
export function NodeToolbar({
  nodeId,
  modality,
  onGenerate,
  onLoad,
  onPickMiniTool,
  visible = true,
}: NodeToolbarProps): React.JSX.Element {
  return (
    <div
      data-testid='node-toolbar'
      data-node-id={nodeId}
      aria-hidden={!visible}
      // `select-none`: ReactFlow portals this toolbar outside the canvas node,
      // so it escapes the node's user-select:none — without it a stray
      // marquee/drag selects the toolbar's text (reads as "selected").
      className={cn(
        'absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 select-none items-center gap-1 rounded-chrome border border-border bg-popover p-1 shadow transition-opacity',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <div className='flex items-center gap-1' data-testid='node-toolbar-left'>
        <NodeGeneratePopover modality={modality} onGenerate={onGenerate} />
        <NodeLoadButton modality={modality} onLoad={onLoad} />
      </div>
      <Separator orientation='vertical' className='mx-1 h-6' />
      <div className='flex items-center gap-1' data-testid='node-toolbar-right'>
        <MiniToolPicker modality={modality} onPick={onPickMiniTool} />
      </div>
    </div>
  );
}
