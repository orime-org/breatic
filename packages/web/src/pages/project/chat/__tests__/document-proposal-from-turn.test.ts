// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a document proposal off a turn (inner#1509), so its card is drawn
 * again after a reload: a refused call carries a reason and no card, and one
 * stored in a shape this build cannot land is named as expired.
 */

import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import { toChatMessage } from '@web/pages/project/chat/to-chat-message';

/**
 * A finished `propose_document_edit` call, as the protocol carries it.
 * @param output - What the tool answered with.
 * @returns The message it sits on.
 */
function turnWith(output: unknown): UIMessage {
  return {
    id: 'm',
    role: 'assistant',
    parts: [{ type: 'tool-propose_document_edit', toolCallId: 'd1', state: 'output-available', input: {}, output }],
  } as unknown as UIMessage;
}

const ACCEPTED = {
  placed: true,
  proposalId: '33333333-3333-4333-8333-333333333333',
  spaceId: '44444444-4444-4444-8444-444444444444',
  spaceName: 'Storyboard',
  kind: 'insert',
  blockId: null,
  body: '## Scene 4',
  title: 'Add scene 4',
  heading: 'Scene 3',
  original: '',
  blockType: null,
  lossy: false,
};

describe('a turn that proposed a document edit', () => {
  it('carries the proposal for its card', () => {
    expect(toChatMessage(turnWith(ACCEPTED)).documentProposals).toEqual([
      expect.objectContaining({ proposalId: ACCEPTED.proposalId, title: 'Add scene 4' }),
    ]);
  });

  it('draws no card for a refused call', () => {
    const message = toChatMessage(turnWith({ placed: false, reason: 'No.' }));

    expect(message.documentProposals).toBeUndefined();
    expect(message.hasExpiredProposal).toBeUndefined();
  });

  it('says a proposal stored in a shape this build cannot land has expired', () => {
    const message = toChatMessage(turnWith({ ...ACCEPTED, kind: 'move' }));

    expect(message.documentProposals).toBeUndefined();
    expect(message.hasExpiredProposal).toBe(true);
  });
});
