// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a proposal off a turn, so the card survives a reload (#229).
 *
 * Nothing about a card is stored: it is rebuilt from the tool call every time
 * the message is read, which is what makes it the same card after a refresh
 * and several turns later. A call that was refused carries a reason instead of
 * a group, and a row stored before this tool existed carries the model's own
 * text -- reading either as a proposal would put a card in front of the reader
 * that builds nothing, or take the whole conversation down while it is built.
 */

import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';

import { toChatMessage } from '@web/pages/project/chat/to-chat-message';

/**
 * A finished `propose_canvas_action` call, as the protocol carries it.
 * @param output - What the tool answered with.
 * @returns The message it sits on.
 */
function turnWith(output: unknown): UIMessage {
  return {
    id: 'm',
    role: 'assistant',
    parts: [
      {
        type: 'tool-propose_canvas_action',
        toolCallId: 'p1',
        state: 'output-available',
        input: {},
        output,
      },
    ],
  } as unknown as UIMessage;
}

const ACCEPTED = {
  placed: true,
  nodes: [
    { role: 'source', type: 'image', name: 'Your photo' },
    { role: 'generate', type: 'image', name: 'Result', mode: 'i2i', model: 'm' },
  ],
  edges: [{ fromIndex: 0, toIndex: 1 }],
  modelNote: 'Quick and faithful',
  rationale: 'Two nodes',
  groupName: 'On a white ground',
};

describe('a turn that proposed a group', () => {
  it('carries the group and what the card says about it', () => {
    const message = toChatMessage(turnWith(ACCEPTED));

    expect(message.proposals).toHaveLength(1);
    expect(message.proposals?.[0]?.nodes).toHaveLength(2);
    expect(message.proposals?.[0]?.edges).toEqual([{ fromIndex: 0, toIndex: 1 }]);
    expect(message.proposals?.[0]?.modelNote).toBe('Quick and faithful');
    expect(message.proposals?.[0]?.rationale).toBe('Two nodes');
  });

  it('carries the name the group will land under', () => {
    // Rebuilt field by field here, so a field left off this list passes the
    // tool's own check and then goes missing on the way to the canvas -- the
    // group lands under the canvas's fixed default and nothing says why.
    const message = toChatMessage(turnWith(ACCEPTED));

    expect(message.proposals?.[0]?.groupName).toBe('On a white ground');
  });
});

describe('a turn whose proposal never reached the reader', () => {
  it('draws no card for one the tool refused', () => {
    const message = toChatMessage(
      turnWith({ placed: false, reason: '"i2i" needs a node to put it in.' }),
    );

    expect(message.proposals).toBeUndefined();
  });

  it('draws no card for a row stored before the tool answered in groups', () => {
    const message = toChatMessage(turnWith('I have proposed a pair of nodes.'));

    expect(message.proposals).toBeUndefined();
  });
});
