// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D Space in front receiving the generation proposals handed in from the
 * chat (inner#1691, design §6.2 · §8.5): it listens while mounted, an idle
 * dialog is opened with the proposal, and a dialog that is submitting says
 * so and opens nothing. Either way the proposal is taken out of the mailbox.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSceneProposals, type SceneGenerateFill } from '@web/stores/scene-proposals';
import { useSceneProposalReceiver } from '@web/spaces/three-d/use-scene-proposal-receiver';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const BUSY = 'Another generation is being submitted.';

/** An image-to-3D fill from a proposal of two views. */
const PROPOSAL: SceneGenerateFill = {
  source: 'agent',
  origin: 'agent',
  mode: 'i23d',
  prompt: '',
  params: { texture: true, pbr: true, texture_quality: 'detailed' },
  images: [
    { assetId: 'a-front', url: 'https://cdn.example/front.png' },
    { assetId: 'a-left', url: 'https://cdn.example/left.png' },
  ],
};

interface Props {
  submitting: boolean;
}

/**
 * Runs the hook with props that can change.
 * @param initial - The first props.
 * @returns The open callback, a way to rerender and a way to unmount.
 */
function run(initial: Props): { open: ReturnType<typeof vi.fn>; rerender: (next: Props) => void; unmount: () => void } {
  const open = vi.fn();
  const { rerender, unmount } = renderHook((p: Props) => useSceneProposalReceiver({ ...p, open }), { initialProps: initial });
  return { open, rerender, unmount };
}

/** Hands the proposal in, the way the card does. */
function handIn(): void {
  act(() => {
    useSceneProposals.getState().request(PROPOSAL);
  });
}

beforeEach(() => {
  useSceneProposals.getState().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

describe('receiving 3D generation proposals', () => {
  it('listens while mounted and stops once unmounted', () => {
    expect(useSceneProposals.getState().listening).toBe(false);

    const { unmount } = run({ submitting: false });
    expect(useSceneProposals.getState().listening).toBe(true);

    unmount();
    expect(useSceneProposals.getState().listening).toBe(false);
  });

  it('opens the dialog with the proposal when the dialog is idle, and empties the mailbox', () => {
    const { open } = run({ submitting: false });

    handIn();

    expect(open.mock.calls).toEqual([[PROPOSAL]]);
    expect(useSceneProposals.getState().incoming).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says another generation is being submitted while the dialog submits, opening nothing, and empties the mailbox', () => {
    const { open } = run({ submitting: true });

    handIn();

    expect(open).not.toHaveBeenCalled();
    expect(useSceneProposals.getState().incoming).toBeNull();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(BUSY);
  });

  it('opens a later proposal once the submit is over', () => {
    const { open, rerender } = run({ submitting: true });
    handIn();
    expect(open).not.toHaveBeenCalled();

    rerender({ submitting: false });
    expect(open).not.toHaveBeenCalled();
    handIn();

    expect(open.mock.calls).toEqual([[PROPOSAL]]);
    expect(useSceneProposals.getState().incoming).toBeNull();
  });
});
