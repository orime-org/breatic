// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The card for a 3D generation proposal (inner#1691, design §6.2 · §8.5). It
 * is bound to no Space, exactly like the Canvas proposal card: it shows what
 * would be generated and its "Open in 3D Space" button hands the proposal to
 * whichever 3D Space is in front. With none in front the button says to open
 * one first and hands nothing in. The button is always available: read-only
 * members never see the Agent column, so the card has no read-only state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SceneGenerationProposal } from '@breatic/shared';

import { SceneGenerationProposalCard } from '@web/pages/project/chat/SceneGenerationProposalCard';
import { useSceneProposals } from '@web/stores/scene-proposals';
import { fillFromProposal } from '@web/spaces/three-d/scene-generation';
import { RAW_CATALOG } from '@web/spaces/three-d/__tests__/scene-generate-fixtures';

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@web/lib/toast', () => ({ toast }));

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/request')>()),
  apiGet: api.get,
}));

const OPEN = 'Open in 3D Space';
const NEED_SCENE = 'Open a 3D Space first.';

const TEXT_TO_3D: SceneGenerationProposal = {
  proposalId: '33333333-3333-4333-8333-333333333333',
  mode: 't23d',
  model: 'tripo-h3.1-t23d',
  prompt: 'A wooden chair',
  params: { texture: true, pbr: true, texture_quality: 'detailed', negative_prompt: 'blurry' },
  images: [],
  credits: 36,
  rationale: 'A chair for the set',
  placed: true,
};

const IMAGE_TO_3D: SceneGenerationProposal = {
  proposalId: '55555555-5555-4555-8555-555555555555',
  mode: 'i23d',
  model: 'tripo-h3.1-multiview',
  prompt: '',
  params: { texture: true, pbr: true, texture_quality: 'standard' },
  images: [
    { assetId: 'a-front', url: 'https://cdn.test/front.png' },
    { assetId: 'a-left', url: 'https://cdn.test/left.png' },
  ],
  credits: 36,
  rationale: 'A chair from the two sketches',
  placed: true,
};

/**
 * Draws the card with a 3D Space in front or not.
 * @param proposal - The proposal it draws.
 * @param listening - Whether a 3D Space is receiving proposals.
 * @returns The render result.
 */
function draw(proposal: SceneGenerationProposal, listening: boolean): ReturnType<typeof render> {
  useSceneProposals.getState().setListening(listening);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SceneGenerationProposalCard proposal={proposal} />
    </QueryClientProvider>,
  );
}

const button = (): HTMLElement => screen.getByRole('button', { name: OPEN });

beforeEach(() => {
  useSceneProposals.getState().reset();
  api.get.mockReset();
  api.get.mockImplementation(async (url: string) => {
    if (url === '/models') return RAW_CATALOG;
    throw new Error(`unexpected GET ${url}`);
  });
  toast.warning.mockReset();
  toast.error.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('what the card shows', () => {
  it('shows the generation mode, the model, the prompt, the main setting and the credits of a text-to-3D proposal', async () => {
    draw(TEXT_TO_3D, true);

    expect(await screen.findByText('Tripo H3.1')).toBeInTheDocument();
    expect(screen.getByText(/\bText to 3D\b/)).toBeInTheDocument();
    expect(screen.getByText('A wooden chair')).toBeInTheDocument();
    // A choice says which setting it sets, since the card has no controls beside it.
    expect(screen.getByText(/Texture quality: Detailed/)).toBeInTheDocument();
    expect(screen.getByText(/\b36\b/)).toBeInTheDocument();
  });

  it('says which switches that are on by default the proposal turns off', async () => {
    draw({ ...TEXT_TO_3D, params: { texture: false, pbr: false } }, true);

    expect(await screen.findByText(/Texture: Off/)).toBeInTheDocument();
    expect(screen.getByText(/PBR: Off/)).toBeInTheDocument();
  });

  it('shows the input images of an image-to-3D proposal in view order', async () => {
    const { container } = draw(IMAGE_TO_3D, true);

    expect(await screen.findByText('Tripo H3.1')).toBeInTheDocument();
    expect(screen.getByText(/\bImage to 3D\b/)).toBeInTheDocument();
    const shown = Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'));
    expect(shown).toEqual(['https://cdn.test/front.png', 'https://cdn.test/left.png']);
  });

  it('names no Space anywhere but the button', async () => {
    const { container } = draw(TEXT_TO_3D, true);
    await screen.findByText('Tripo H3.1');

    const text = (container.textContent ?? '').replace(OPEN, '');
    expect(text).not.toMatch(/Space/);
  });
});

describe('the Open in 3D Space button', () => {
  it('is available with no 3D Space in front', () => {
    draw(TEXT_TO_3D, false);

    expect(button()).toBeEnabled();
    expect(button()).not.toHaveAttribute('aria-disabled', 'true');
    expect(button()).not.toHaveAttribute('aria-busy', 'true');
  });

  it('says to open a 3D Space first when none is in front, handing nothing in', async () => {
    const user = userEvent.setup();
    draw(TEXT_TO_3D, false);

    await user.click(button());

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(NEED_SCENE);
    expect(useSceneProposals.getState().incoming).toBeNull();
  });

  it('hands the proposal to the 3D Space in front, saying nothing', async () => {
    const user = userEvent.setup();
    draw(TEXT_TO_3D, true);

    await user.click(button());

    expect(useSceneProposals.getState().incoming).toEqual(fillFromProposal(TEXT_TO_3D));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays available after a press, and a second press hands the proposal in again', async () => {
    const user = userEvent.setup();
    draw(TEXT_TO_3D, true);
    await user.click(button());
    // The Space in front takes it out, as the receiver does.
    act(() => {
      useSceneProposals.getState().take();
    });

    expect(button()).toBeEnabled();
    expect(button()).not.toHaveAttribute('aria-busy', 'true');
    await user.click(button());

    expect(useSceneProposals.getState().incoming).toEqual(fillFromProposal(TEXT_TO_3D));
  });
});
