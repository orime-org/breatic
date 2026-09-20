// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the reader's attention goes once a flow is placed (#263).
 *
 * Never on the camera: the zoom and the middle of the screen are what they
 * set, and a flow arriving does not take that off them. So the only questions
 * here are what is selected and whether a panel opens -- and the answer turns
 * on how many things in the flow are waiting to be generated.
 */

import { describe, it, expect } from 'vitest';
import type { CanvasProposal, ProposalNode } from '@breatic/shared';

import { whatToFocus } from '@web/spaces/canvas/lib/after-placing';

/** A node waiting for the reader to press Generate. */
const generates = (name: string): ProposalNode => ({
  role: 'generate',
  type: 'image',
  name,
  mode: 't2i',
  model: 'a-model',
  prompt: [{ text: 'white ground' }],
});

/** A node carrying words already written. */
const written = (name: string): ProposalNode => ({
  role: 'written',
  type: 'text',
  name,
  prompt: [{ text: 'a pour-over kettle' }],
});

/** A proposal out of nodes. */
const flow = (nodes: ProposalNode[]): CanvasProposal => ({
  nodes,
  edges: [],
  rationale: '',
});

describe('what the canvas puts the reader on', () => {
  it('opens the one panel there is, so they read the prompt just written', () => {
    const proposal = flow([written('Copy'), generates('Result')]);

    const focus = whatToFocus(proposal, { nodeIds: ['n-copy', 'n-result'], groupId: 'g-1' });

    expect(focus).toEqual({
      select: ['n-result'],
      panel: { nodeId: 'n-result', type: 'image' },
    });
  });

  it('selects the group and opens nothing when several things generate', () => {
    // A panel is up to 600px wide and hangs under its own node, so opening
    // one covers the others -- the same thing as moving the camera on them.
    const proposal = flow([generates('One'), generates('Two'), generates('Three')]);

    const focus = whatToFocus(proposal, {
      nodeIds: ['n-1', 'n-2', 'n-3'],
      groupId: 'g-1',
    });

    expect(focus).toEqual({ select: ['g-1'] });
  });

  it('points at nothing when the flow is words alone', () => {
    const proposal = flow([written('Copy')]);

    const focus = whatToFocus(proposal, { nodeIds: ['n-copy'] });

    expect(focus).toEqual({ select: [] });
  });
});
