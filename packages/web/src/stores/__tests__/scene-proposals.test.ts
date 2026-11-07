// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D generation proposals waiting to be taken up by their 3D Space
 * (inner#1691, design §6.2 · §8.5): one entry per pressed card, a second press
 * of a waiting card ignored, only the last press kept per Space, and every
 * entry gone once its Space took it up or it was reported.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneGenerationProposal } from '@breatic/shared';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

import { useSceneProposals } from '@web/stores/scene-proposals';

/**
 * A text-to-3D proposal for a 3D Space.
 * @param proposalId - Its id.
 * @param spaceId - Its 3D Space.
 * @returns The proposal.
 */
function proposal(proposalId: string, spaceId = 's1'): SceneGenerationProposal {
  return {
    proposalId,
    spaceId,
    spaceName: 'Props',
    mode: 't23d',
    model: 'tripo-h3.1-t23d',
    prompt: 'A wooden chair',
    negative_prompt: '',
    params: { texture: true, pbr: true, texture_quality: 'standard' },
    images: [],
    credits: 30,
    rationale: 'A chair for the set',
    placed: true,
  };
}

const store = (): ReturnType<typeof useSceneProposals.getState> => useSceneProposals.getState();

beforeEach(() => {
  store().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe('a pressed scene proposal', () => {
  it('waits under its proposal id once pressed', () => {
    store().start(proposal('p1'));

    expect(Object.keys(store().pending)).toEqual(['p1']);
    expect(store().pending.p1?.proposal).toEqual(proposal('p1'));
  });

  it('ignores a second press of the same card while it waits, saying nothing', () => {
    store().start(proposal('p1'));
    store().start({ ...proposal('p1'), prompt: 'A pressed-again prompt' });

    expect(Object.keys(store().pending)).toEqual(['p1']);
    expect(store().pending.p1?.proposal.prompt).toBe('A wooden chair');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('keeps only the last press for one Space, dropping the earlier one with a toast', () => {
    store().start(proposal('p1'));
    store().start(proposal('p2'));

    expect(Object.keys(store().pending)).toEqual(['p2']);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith('Switched to the newer proposal.');
  });

  it('keeps presses for different Spaces side by side', () => {
    store().start(proposal('p1', 's1'));
    store().start(proposal('p2', 's2'));

    expect(Object.keys(store().pending).sort()).toEqual(['p1', 'p2']);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('ending a waiting press', () => {
  it('drops it quietly once its Space took it up', () => {
    store().start(proposal('p1'));
    store().report('p1', 'opened');

    expect(store().pending).toEqual({});
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['spaceGone', 'The target Space does not exist.'],
    ['tabClosed', 'The tab was closed, so the proposal was not opened.'],
    ['busy', 'Another generation is being submitted.'],
    ['readOnly', 'Read-only members cannot generate.'],
    ['unopenable', 'This 3D Space cannot be opened right now, so the proposal was not opened.'],
  ] as const)('drops it with a warning when it is reported %s', (outcome, line) => {
    store().start(proposal('p1'));
    store().report('p1', outcome);

    expect(store().pending).toEqual({});
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(line);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('takes no report for a card with no press waiting', () => {
    store().report('p1', 'spaceGone');

    expect(store().pending).toEqual({});
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('reports every press waiting on one Space at once, leaving other Spaces alone', () => {
    store().start(proposal('p1', 's1'));
    store().start(proposal('p2', 's2'));

    store().reportSpace('s1', 'unopenable');

    expect(Object.keys(store().pending)).toEqual(['p2']);
    expect(toast.warning).toHaveBeenCalledWith('This 3D Space cannot be opened right now, so the proposal was not opened.');
  });

  it('can be pressed again once it was reported', () => {
    store().start(proposal('p1'));
    store().report('p1', 'busy');
    store().start(proposal('p1'));

    expect(Object.keys(store().pending)).toEqual(['p1']);
  });
});

describe('reset', () => {
  it('clears every waiting press without a toast', () => {
    store().start(proposal('p1', 's1'));
    store().start(proposal('p2', 's2'));

    store().reset();

    expect(store().pending).toEqual({});
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
