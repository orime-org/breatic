// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The card for a 3D generation proposal (inner#1691, design §6.2 · §8.5): its
 * "Open in 3D Space" button is worked out on every render from the current
 * facts, taking the first that holds -- read-only member, Spaces not yet
 * arrived, target gone or not a 3D Space, this card waiting, otherwise
 * available -- so no event can leave a read-only member with a live button.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SceneGenerationProposal } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { SceneGenerationProposalCard } from '@web/pages/project/chat/SceneGenerationProposalCard';
import { useSceneProposals } from '@web/stores/scene-proposals';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SPACE = '44444444-4444-4444-8444-444444444444';
const SCENE: ProjectSpace = { id: SPACE, name: 'Props', type: '3d', createdAt: 1 };
const OPEN = 'Open in 3D Space';
const GONE = 'The target Space does not exist.';
const READ_ONLY = 'Read-only members cannot generate.';

const PROPOSAL: SceneGenerationProposal = {
  proposalId: '33333333-3333-4333-8333-333333333333',
  spaceId: SPACE,
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

interface Facts {
  spaces: readonly ProjectSpace[];
  spacesReady: boolean;
  readOnly: boolean;
}

/**
 * The card inside a project route, with facts that can change.
 * @param facts - The current facts.
 * @returns The element.
 */
function card(facts: Facts): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/project/demo-${PROJECT}`]}>
        <Routes>
          <Route
            path='/project/:projectId'
            element={
              <SceneGenerationProposalCard
                proposal={PROPOSAL}
                spaces={facts.spaces}
                spacesReady={facts.spacesReady}
                readOnly={facts.readOnly}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let client: QueryClient;

/**
 * Draws the card.
 * @param facts - The first facts.
 * @returns A way to redraw it with new facts.
 */
function draw(facts: Facts): (next: Facts) => void {
  const { rerender } = render(card(facts));
  return (next) => {
    rerender(card(next));
  };
}

const button = (): HTMLElement => screen.getByRole('button', { name: OPEN });

/** What a button looks like to the user, in the order of the design §6.2 table. */
type Look = 'readOnly' | 'available' | 'gone' | 'waiting';

/**
 * Reads which look the button has.
 * @param el - The button.
 * @returns Its look.
 */
function lookOf(el: HTMLElement): Look {
  if (el.hasAttribute('disabled')) return 'gone';
  if (el.getAttribute('aria-busy') === 'true') return 'waiting';
  if (el.getAttribute('aria-disabled') === 'true') return 'readOnly';
  return 'available';
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSceneProposals.getState().reset();
  toast.warning.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('the Open in 3D Space button', () => {
  it('is aria-disabled for a read-only member, and a click says why without pressing', async () => {
    const user = userEvent.setup();
    draw({ spaces: [SCENE], spacesReady: true, readOnly: true });

    expect(button()).toHaveAttribute('aria-disabled', 'true');
    expect(button()).not.toHaveAttribute('disabled');
    expect(button()).not.toHaveAttribute('aria-busy', 'true');

    await user.click(button());

    expect(toast.warning).toHaveBeenCalledWith(READ_ONLY);
    expect(useSceneProposals.getState().pending).toEqual({});
  });

  it('can be pressed before the project\'s Spaces arrive, and the press waits for them', async () => {
    const user = userEvent.setup();
    draw({ spaces: [], spacesReady: false, readOnly: false });

    expect(lookOf(button())).toBe('available');
    expect(screen.queryByText(GONE)).toBeNull();

    await user.click(button());

    expect(Object.keys(useSceneProposals.getState().pending)).toEqual([PROPOSAL.proposalId]);
    expect(useSceneProposals.getState().pending[PROPOSAL.proposalId]?.proposal).toEqual(PROPOSAL);
  });

  it('is unavailable and says the target Space does not exist when it is not in the project', () => {
    draw({ spaces: [], spacesReady: true, readOnly: false });

    expect(button()).toBeDisabled();
    expect(screen.getByText(GONE)).toBeInTheDocument();
  });

  it('is unavailable when the target Space is not a 3D Space', () => {
    draw({ spaces: [{ ...SCENE, type: 'canvas' }], spacesReady: true, readOnly: false });

    expect(button()).toBeDisabled();
    expect(screen.getByText(GONE)).toBeInTheDocument();
  });

  it('shows loading while this card waits, and a second press is ignored', async () => {
    const user = userEvent.setup();
    draw({ spaces: [SCENE], spacesReady: true, readOnly: false });

    await user.click(button());

    expect(lookOf(button())).toBe('waiting');
    expect(button()).toHaveAttribute('aria-busy', 'true');

    await user.click(button());

    expect(Object.keys(useSceneProposals.getState().pending)).toEqual([PROPOSAL.proposalId]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('is available again once the press was reported', async () => {
    const user = userEvent.setup();
    draw({ spaces: [SCENE], spacesReady: true, readOnly: false });
    await user.click(button());

    act(() => {
      useSceneProposals.getState().report(PROPOSAL.proposalId, 'busy');
    });

    expect(lookOf(button())).toBe('available');
  });

  it('is available for an Editor whose target is a 3D Space in the project', () => {
    draw({ spaces: [SCENE], spacesReady: true, readOnly: false });

    expect(lookOf(button())).toBe('available');
    expect(screen.queryByText(GONE)).toBeNull();
  });

  it('puts read-only first: a read-only member waiting on a gone target still sees the read-only look', async () => {
    const user = userEvent.setup();
    const redraw = draw({ spaces: [SCENE], spacesReady: true, readOnly: false });
    await user.click(button());

    redraw({ spaces: [], spacesReady: true, readOnly: true });

    expect(lookOf(button())).toBe('readOnly');
  });

  it('follows Editor, target deleted, downgraded to read-only, target restored', () => {
    const redraw = draw({ spaces: [SCENE], spacesReady: true, readOnly: false });
    const seen: Look[] = [lookOf(button())];

    redraw({ spaces: [], spacesReady: true, readOnly: false });
    seen.push(lookOf(button()));
    redraw({ spaces: [], spacesReady: true, readOnly: true });
    seen.push(lookOf(button()));
    redraw({ spaces: [SCENE], spacesReady: true, readOnly: true });
    seen.push(lookOf(button()));

    expect(seen).toEqual(['available', 'gone', 'readOnly', 'readOnly']);
  });
});
