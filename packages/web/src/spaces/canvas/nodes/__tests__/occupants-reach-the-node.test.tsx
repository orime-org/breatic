// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The holders travel from the node's `data` to the tags above its name.
 *
 * This is the wiring the design called out as absent: `ContentNodeFrameProps`
 * is a fixed set of named parameters that the six modality components build
 * literally, so nothing reaches the frame unless a layer in between publishes
 * it. Each component test on its own passes with the wire cut.
 */

import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { attachOccupants } from '@web/spaces/canvas/attach-occupants';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';

/**
 * Build a roster that answers from a plain map.
 * @param names - User id to display name; a missing id resolves to null.
 * @returns The roster bundle the provider publishes.
 */
function roster(names: Record<string, string>): CollaboratorNames {
  return { resolve: (userId: string) => names[userId] ?? null, members: [] };
}

const ACTIONS = {
  renameNode: vi.fn(),
  deleteEdge: () => undefined,
  activateNodeUpload: () => undefined,
  commitGroupResize: () => undefined,
  reportGroupResize: () => undefined,
  retryNodeUpload: vi.fn(),
  hasUploadRetryFile: () => false,
};

/**
 * Render one node the way the canvas does, with the holders baked onto it by
 * the mirror rather than handed to the frame directly.
 * @param kind - Which node type to render.
 * @param holders - Who is holding it.
 * @param names - The roster to resolve them against.
 * @param handlingByUserId - Who started a run on it; absent leaves it idle.
 */
function renderNode(
  kind: 'image' | 'group',
  holders: readonly string[],
  names: Record<string, string>,
  handlingByUserId?: string,
): void {
  const base = {
    id: 'n1',
    type: kind,
    position: { x: 0, y: 0 },
    data:
      kind === 'group'
        ? { kind: 'group', status: 'idle', name: 'A group' }
        : {
          kind: 'image',
          status: handlingByUserId === undefined ? 'idle' : 'handling',
          name: 'A node',
          handlingByUserId,
        },
  };
  const withHolders = attachOccupants(
    base as Parameters<typeof attachOccupants>[0],
    new Map(holders.length > 0 ? [['n1', holders]] : []),
  );
  const NodeComponent = FLOW_NODE_TYPES[kind];
  render(
    <ReactFlowProvider>
      <CollaboratorNamesProvider value={roster(names)}>
        <CanvasActionsContext.Provider value={ACTIONS}>
          <NodeComponent
            {...({
              id: 'n1',
              data: withHolders.data,
              selected: false,
            } as unknown as NodeProps)}
          />
        </CanvasActionsContext.Provider>
      </CollaboratorNamesProvider>
    </ReactFlowProvider>,
  );
}

describe('the holders reaching a node', () => {
  it('shows them above a content node name', () => {
    renderNode('image', ['u1'], { u1: 'Alice' });

    expect(screen.getByTestId('node-occupant-tags')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows them above a group name', () => {
    renderNode('group', ['u1'], { u1: 'Alice' });

    expect(screen.getByTestId('node-occupant-tags')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('draws nothing above a node nobody is holding', () => {
    renderNode('image', [], { u1: 'Alice' });

    expect(screen.queryByTestId('node-occupant-tags')).not.toBeInTheDocument();
  });

  it('names whoever started a running generation', () => {
    // Generating is the longest a node stays busy, and the person who started
    // it is holding it in every sense that matters to a viewer — the tag says
    // so with the same visual as a selection tag.
    renderNode('image', [], { u1: 'Alice' }, 'u1');

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('draws one tag for someone who both started the generation and holds the node', () => {
    // The two sources answer the same question, so a person who is in both
    // must not be drawn twice — that would read as two collaborators.
    renderNode('image', ['u1'], { u1: 'Alice' }, 'u1');

    expect(screen.getAllByText('Alice')).toHaveLength(1);
  });

  it('draws both the starter and a separate holder', () => {
    renderNode('image', ['u2'], { u1: 'Alice', u2: 'Bob' }, 'u1');

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  // The row draws two names and counts the rest, so position decides who is
  // seen. The starter is the one holder whose identity has no second source:
  // a running generation names its author nowhere else on the node, and the
  // handling outlives its starter's presence. Anyone folded into the count is
  // still counted, so nobody is lost. Both cases below read the whole row in
  // order, which pins the position, the cap and the count in one assertion.
  it('names the starter first when the row has to count the rest', () => {
    renderNode('image', ['u2', 'u3'], { u1: 'Alice', u2: 'Bob', u3: 'Carol' }, 'u1');

    expect(screen.getByTestId('node-occupant-tags')).toHaveTextContent('AliceBob+1');
  });

  it('names the starter first when they are also holding the node', () => {
    // The common case: whoever pressed generate usually still has the node
    // selected, so they arrive through both channels and the join must lift
    // them out of whatever order awareness happened to deliver.
    renderNode('image', ['u2', 'u3', 'u1'], { u1: 'Alice', u2: 'Bob', u3: 'Carol' }, 'u1');

    expect(screen.getByTestId('node-occupant-tags')).toHaveTextContent('AliceBob+1');
  });

  it('lines the row up with each name, which the two mounts indent differently', () => {
    // A content node's name sits inside a header with its own 4px padding; a
    // group's name has none. One unparameterised component would be 4px off in
    // whichever of the two it was not tuned for, so each mount passes its own
    // inset and both are read back here.
    renderNode('image', ['u1'], { u1: 'Alice' });
    expect(screen.getByTestId('node-occupant-tags').style.paddingLeft).toBe('4px');

    cleanup();

    renderNode('group', ['u1'], { u1: 'Alice' });
    expect(screen.getByTestId('node-occupant-tags').style.paddingLeft).toBe('0px');
  });

  it('keeps the tags inside the name anchor, not on the render root', () => {
    // Hung on the render root the row would land on the node name's own line:
    // the root's top edge IS the card's top edge (measured on a real canvas,
    // 2026-08-25). Inside the anchor it stacks above the name instead.
    renderNode('image', ['u1'], { u1: 'Alice' });

    const anchor = screen.getByTestId('node-header-anchor');
    expect(anchor).toContainElement(screen.getByTestId('node-occupant-tags'));
  });
});
