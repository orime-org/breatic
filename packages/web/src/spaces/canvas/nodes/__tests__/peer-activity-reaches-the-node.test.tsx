// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Someone else's activity reaches an empty node through the node wrapper,
 * which knows the node's task counts (inner#1303 §6.8): shown on a node with
 * no tasks, kept off one that has any.
 */

import { render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';

// ReactFlow provides the node id to a node it renders; rendered directly, the
// wrapper has no such parent.
vi.mock('@xyflow/react', async (original) => ({ ...(await original<object>()), useNodeId: () => 'n1' }));

import { TooltipProvider } from '@web/components/ui/tooltip';
import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { PeerActivityContext } from '@web/spaces/canvas/nodes/_shared/node-peer-activity-context';

const ACTIONS = {
  renameNode: () => undefined,
  deleteEdge: () => undefined,
  deleteNode: () => undefined,
  activateNodeUpload: () => undefined,
  commitGroupResize: () => undefined,
  reportGroupResize: () => undefined,
  beginGroupResize: () => undefined,
};

const NO_TASKS = { running: 0, done: 0, failed: 0, expired: 0 };

/**
 * Render an empty image node that Bob is uploading into.
 * @param taskCounts - The node's task counts, if it has any.
 */
function renderNode(taskCounts?: typeof NO_TASKS): void {
  const NodeComponent = FLOW_NODE_TYPES.image;
  render(
    <ReactFlowProvider>
      <TooltipProvider>
        <CollaboratorNamesProvider value={{ resolve: (id) => (id === 'bob' ? 'Bob' : null), members: [] }}>
          <CanvasActionsContext.Provider value={ACTIONS}>
            <PeerActivityContext.Provider value={new Map([['n1', { userId: 'bob', action: 'upload', at: 1 }]])}>
              <NodeComponent
                {...({
                  id: 'n1',
                  type: 'image',
                  data: { handling: false, name: 'A node', ...(taskCounts && { taskCounts }) },
                  selected: false,
                } as unknown as NodeProps)}
              />
            </PeerActivityContext.Provider>
          </CanvasActionsContext.Provider>
        </CollaboratorNamesProvider>
      </TooltipProvider>
    </ReactFlowProvider>,
  );
}

describe('someone else’s activity reaching an empty node', () => {
  it('shows on a node with no task counts', () => {
    renderNode();
    expect(screen.getByText('Bob is uploading')).toBeInTheDocument();
  });

  it('shows on a node whose counts are all zero', () => {
    renderNode(NO_TASKS);
    expect(screen.getByText('Bob is uploading')).toBeInTheDocument();
  });

  it.each(['running', 'done', 'failed', 'expired'] as const)(
    'stays off a node with a %s task',
    (state) => {
      renderNode({ ...NO_TASKS, [state]: 1 });
      expect(screen.queryByText('Bob is uploading')).toBeNull();
    },
  );
});
