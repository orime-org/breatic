// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The mailbox between a 3D generation proposal card and the 3D Space in front
 * (inner#1691, design §6.2 · §8.5). Like the canvas mailbox, it is bound to no
 * Space: whichever 3D Space is showing says it is listening, the card hands
 * its proposal in, and that Space takes it out.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneGenerationProposal } from '@breatic/shared';

import { useSceneProposals } from '@web/stores/scene-proposals';

/**
 * A text-to-3D proposal.
 * @param proposalId - Its id.
 * @returns The proposal.
 */
function proposal(proposalId: string): SceneGenerationProposal {
  return {
    proposalId,
    mode: 't23d',
    model: 'tripo-h3.1-t23d',
    prompt: 'A wooden chair',
    params: { texture: true, pbr: true, texture_quality: 'standard', negative_prompt: '' },
    images: [],
    credits: 30,
    rationale: 'A chair for the set',
    placed: true,
  };
}

const store = (): ReturnType<typeof useSceneProposals.getState> => useSceneProposals.getState();

beforeEach(() => {
  store().reset();
});

describe('the 3D proposal mailbox', () => {
  it('starts with nobody listening and nothing waiting', () => {
    expect(store().listening).toBe(false);
    expect(store().incoming).toBeNull();
  });

  it('holds a proposal handed in while a 3D Space listens', () => {
    store().setListening(true);
    store().request(proposal('p1'));

    expect(store().incoming).toEqual(proposal('p1'));
  });

  it('gives the proposal to whoever takes it, and is empty afterwards', () => {
    store().setListening(true);
    store().request(proposal('p1'));

    const taken = store().take();

    expect(taken).toEqual(proposal('p1'));
    expect(store().incoming).toBeNull();
    expect(store().take()).toBeNull();
  });

  it('says nobody is listening once the 3D Space stops', () => {
    store().setListening(true);
    expect(store().listening).toBe(true);

    store().setListening(false);

    expect(store().listening).toBe(false);
  });

  it('forgets both the listener and the waiting proposal on reset', () => {
    store().setListening(true);
    store().request(proposal('p1'));

    store().reset();

    expect(store().listening).toBe(false);
    expect(store().incoming).toBeNull();
  });
});
