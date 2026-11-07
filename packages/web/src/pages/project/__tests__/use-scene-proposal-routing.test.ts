// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The project page sending a pressed 3D generation card to its 3D Space
 * (inner#1691, design §6.2 · §8.5): nothing judged before the project's
 * Spaces arrive, a target that is gone or is not a 3D Space reported at once,
 * the tab opened or switched to, and a card whose tab was closed before the
 * Space took it up reported.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneGenerationProposal } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { useSceneProposalRouting } from '@web/pages/project/use-scene-proposal-routing';
import { useSceneProposals } from '@web/stores/scene-proposals';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const SCENE: ProjectSpace = { id: 's1', name: 'Props', type: '3d', createdAt: 1 };
const CANVAS: ProjectSpace = { id: 'c1', name: 'Cast', type: 'canvas', createdAt: 2 };

const GONE = 'The target Space does not exist.';
const TAB_CLOSED = 'The tab was closed, so the proposal was not opened.';

/**
 * A text-to-3D proposal for a Space.
 * @param proposalId - Its id.
 * @param spaceId - Its Space.
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
    params: { texture: true },
    images: [],
    credits: 30,
    rationale: 'A chair for the set',
    placed: true,
  };
}

const pending = (): ReturnType<typeof useSceneProposals.getState>['pending'] => useSceneProposals.getState().pending;

interface Props {
  spaces: readonly ProjectSpace[];
  openIds: readonly string[];
  activeId: string | null;
  ready: boolean;
}

/**
 * Runs the hook with props that can change.
 * @param initial - The first props.
 * @returns The open callback and a way to rerender.
 */
function run(initial: Props): { open: ReturnType<typeof vi.fn>; rerender: (next: Props) => void } {
  const open = vi.fn();
  const { rerender } = renderHook((p: Props) => useSceneProposalRouting(p.spaces, p.openIds, p.activeId, open, p.ready), {
    initialProps: initial,
  });
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

describe('a pressed 3D generation card', () => {
  it('waits for the project\'s Spaces to arrive before judging', () => {
    const { open, rerender } = run({ spaces: [], openIds: [], activeId: null, ready: false });

    press(proposal('p1'));
    expect(Object.keys(pending())).toEqual(['p1']);
    expect(open).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();

    rerender({ spaces: [SCENE], openIds: [], activeId: null, ready: true });
    expect(open.mock.calls).toEqual([['s1']]);
    expect(Object.keys(pending())).toEqual(['p1']);
  });

  it('opens its 3D Space, once', () => {
    const { open, rerender } = run({ spaces: [SCENE, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    press(proposal('p1'));
    rerender({ spaces: [SCENE, CANVAS], openIds: ['c1', 's1'], activeId: 's1', ready: true });

    expect(open.mock.calls).toEqual([['s1']]);
    expect(Object.keys(pending())).toEqual(['p1']);
  });

  it('switches to its 3D Space when the tab is open behind another', () => {
    const { open } = run({ spaces: [SCENE, CANVAS], openIds: ['c1', 's1'], activeId: 'c1', ready: true });

    press(proposal('p1'));

    expect(open.mock.calls).toEqual([['s1']]);
  });

  it('opens nothing for a 3D Space already in front', () => {
    const { open } = run({ spaces: [SCENE], openIds: ['s1'], activeId: 's1', ready: true });

    press(proposal('p1'));

    expect(open).not.toHaveBeenCalled();
    expect(Object.keys(pending())).toEqual(['p1']);
  });

  it('says the target Space does not exist when it is not in the project', () => {
    const { open } = run({ spaces: [CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    press(proposal('p1'));

    expect(pending()).toEqual({});
    expect(open).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(GONE);
  });

  it('says the target Space does not exist when it is not a 3D Space', () => {
    const { open } = run({ spaces: [CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    press(proposal('p1', 'c1'));

    expect(pending()).toEqual({});
    expect(open).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(GONE);
  });

  it('says the target Space does not exist when it is deleted before the Space took the card up', () => {
    const { rerender } = run({ spaces: [SCENE], openIds: ['s1'], activeId: 's1', ready: true });
    press(proposal('p1'));

    rerender({ spaces: [], openIds: [], activeId: null, ready: true });

    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(GONE);
  });

  it('says the tab was closed when it is closed after opening and before the Space took the card up', () => {
    const { rerender } = run({ spaces: [SCENE, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });
    press(proposal('p1'));
    rerender({ spaces: [SCENE, CANVAS], openIds: ['c1', 's1'], activeId: 's1', ready: true });

    rerender({ spaces: [SCENE, CANVAS], openIds: ['c1'], activeId: 'c1', ready: true });

    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(TAB_CLOSED);
    expect(toast.warning).not.toHaveBeenCalledWith(GONE);
  });

  it('says the tab was closed when the card was pressed with its Space in front and the tab is then closed', () => {
    const { rerender } = run({ spaces: [SCENE], openIds: ['s1'], activeId: 's1', ready: true });
    press(proposal('p1'));

    rerender({ spaces: [SCENE], openIds: [], activeId: null, ready: true });

    expect(pending()).toEqual({});
    expect(toast.warning).toHaveBeenCalledWith(TAB_CLOSED);
  });

  it('keeps the card waiting when the user switches away from its open 3D Space', () => {
    const { rerender } = run({ spaces: [SCENE, CANVAS], openIds: ['c1', 's1'], activeId: 's1', ready: true });
    press(proposal('p1'));

    rerender({ spaces: [SCENE, CANVAS], openIds: ['c1', 's1'], activeId: 'c1', ready: true });

    expect(Object.keys(pending())).toEqual(['p1']);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
