// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D Space taking up the generation cards pressed for it (inner#1691,
 * design §6.2 · §8.5): nothing taken while the project role is unknown, an
 * Editor with an idle dialog gets the dialog opened with the proposal, a
 * dialog that is submitting or a read-only member is reported, and a scene
 * that cannot be opened reports every card waiting on it.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRole, SceneGenerationProposal } from '@breatic/shared';

import { useSceneProposals } from '@web/stores/scene-proposals';
import { useSceneProposalPickup } from '@web/spaces/three-d/use-scene-proposal-pickup';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const BUSY = 'Another generation is being submitted.';
const READ_ONLY = 'Read-only members cannot generate.';
const UNOPENABLE = 'This 3D Space cannot be opened right now, so the proposal was not opened.';

/**
 * An image-to-3D proposal for a 3D Space.
 * @param proposalId - Its id.
 * @param spaceId - Its 3D Space.
 * @returns The proposal.
 */
function proposal(proposalId: string, spaceId = 's1'): SceneGenerationProposal {
  return {
    proposalId,
    spaceId,
    spaceName: 'Props',
    mode: 'i23d',
    model: 'tripo-h3.1-multiview',
    prompt: '',
    negative_prompt: '',
    params: { texture: true, pbr: true, texture_quality: 'detailed' },
    images: [
      { assetId: 'a-front', url: 'https://cdn.example/front.png' },
      { assetId: 'a-left', url: 'https://cdn.example/left.png' },
    ],
    credits: 40,
    rationale: 'A chair from the two sketches',
    placed: true,
  };
}

const pending = (): ReturnType<typeof useSceneProposals.getState>['pending'] => useSceneProposals.getState().pending;

interface Props {
  spaceId: string;
  role: ProjectRole | undefined;
  submitting: boolean;
  unopenable: boolean;
}

/**
 * Runs the hook with props that can change.
 * @param initial - The first props.
 * @returns The open callback and a way to rerender.
 */
function run(initial: Props): { open: ReturnType<typeof vi.fn>; rerender: (next: Props) => void } {
  const open = vi.fn();
  const { rerender } = renderHook((p: Props) => useSceneProposalPickup({ ...p, open }), { initialProps: initial });
  return { open, rerender };
}

/**
 * Presses a card.
 * @param p - The proposal pressed.
 */
function press(p: SceneGenerationProposal): void {
  act(() => {
    useSceneProposals.getState().start(p);
  });
}

beforeEach(() => {
  useSceneProposals.getState().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe('taking up a 3D generation card', () => {
  it('waits while the project role is unknown, then takes it up once the role is known', () => {
    const { open, rerender } = run({ spaceId: 's1', role: undefined, submitting: false, unopenable: false });
    press(proposal('p1'));

    expect(open).not.toHaveBeenCalled();
    expect(Object.keys(pending())).toEqual(['p1']);
    expect(toast.warning).not.toHaveBeenCalled();

    rerender({ spaceId: 's1', role: 'editor', submitting: false, unopenable: false });

    expect(open.mock.calls).toEqual([[proposal('p1')]]);
    expect(pending()).toEqual({});
  });

  it.each(['editor', 'owner'] as const)('opens the dialog with the proposal for an %s with an idle dialog, and drops the card', (role) => {
    const { open } = run({ spaceId: 's1', role, submitting: false, unopenable: false });

    press(proposal('p1'));

    expect(open.mock.calls).toEqual([[proposal('p1')]]);
    expect(pending()).toEqual({});
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('takes up a card pressed before the Space was shown', () => {
    press(proposal('p1'));

    const { open } = run({ spaceId: 's1', role: 'editor', submitting: false, unopenable: false });

    expect(open.mock.calls).toEqual([[proposal('p1')]]);
    expect(pending()).toEqual({});
  });

  it('leaves cards for other Spaces waiting', () => {
    const { open } = run({ spaceId: 's1', role: 'editor', submitting: false, unopenable: false });

    press(proposal('p2', 's2'));

    expect(open).not.toHaveBeenCalled();
    expect(Object.keys(pending())).toEqual(['p2']);
  });

  it('reports another generation being submitted while the dialog submits, opening nothing', () => {
    const { open } = run({ spaceId: 's1', role: 'editor', submitting: true, unopenable: false });

    press(proposal('p1'));

    expect(open).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(BUSY);
  });

  it('reports that read-only members cannot generate, opening nothing', () => {
    const { open } = run({ spaceId: 's1', role: 'viewer', submitting: false, unopenable: false });

    press(proposal('p1'));

    expect(open).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(READ_ONLY);
  });

  it('reports a member who became read-only after pressing', () => {
    press(proposal('p1'));

    const { open } = run({ spaceId: 's1', role: 'viewer', submitting: false, unopenable: false });

    expect(open).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(READ_ONLY);
  });
});

describe('a 3D Space whose scene cannot be opened (older format, load error)', () => {
  it('reports the card once and drops it, opening nothing', () => {
    press(proposal('p1'));

    const { open } = run({ spaceId: 's1', role: 'editor', submitting: false, unopenable: true });

    expect(open).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(UNOPENABLE);
  });

  it('reports a card pressed while it is shown, whatever the role', () => {
    const { open } = run({ spaceId: 's1', role: undefined, submitting: false, unopenable: true });

    press(proposal('p1'));

    expect(open).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(UNOPENABLE);
  });

  it('leaves cards for other Spaces waiting', () => {
    press(proposal('p2', 's2'));

    run({ spaceId: 's1', role: 'editor', submitting: false, unopenable: true });

    expect(Object.keys(pending())).toEqual(['p2']);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
