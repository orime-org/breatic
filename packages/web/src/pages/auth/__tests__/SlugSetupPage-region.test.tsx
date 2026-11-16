// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Onboarding places the personal Studio in a region (inner#1955): the region
 * comes from the user's time zone and is never shown; the browser generates
 * the Studio's id and keeps it while the form is unchanged; when the region
 * cannot finish the creation right now the page says so and Continue tries
 * again; a creation the region already gave up on is resubmitted once under
 * a new id. A build with one region sends no region.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import SlugSetupPage from '@web/pages/auth/SlugSetupPage';
import { authApi } from '@web/data/api/auth';
import { ApiException } from '@web/data/api/types';
import { parseRegionConfig, type RegionConfig } from '@web/data/api/regions';
import { useCurrentUserStore } from '@web/stores';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';

const regionConfig = vi.hoisted(() => ({ current: null as RegionConfig | null }));

vi.mock('@web/data/api/regions', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/regions')>('@web/data/api/regions');
  return { ...actual, getRegionConfig: () => regionConfig.current };
});

vi.mock('@web/data/api/auth', async () => {
  const actual = await vi.importActual<typeof import('@web/data/api/auth')>('@web/data/api/auth');
  return { ...actual, authApi: { setupStudio: vi.fn() } };
});

vi.mock('@web/pages/studio/container/dialogs/use-slug-availability');

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Pretend the browser reports a time zone.
 * @param timeZone - The IANA zone.
 */
function inTimeZone(timeZone: string): void {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

/**
 * Render the onboarding page with a `/studio` destination.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/choose-slug']}>
        <Routes>
          <Route path='/choose-slug' element={<SlugSetupPage />} />
          <Route path='/studio' element={<div data-testid='studio-page' />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * A refusal carrying a reason, as the server sends it.
 * @param status - The HTTP status.
 * @param reason - The `error.reason`.
 * @returns The exception the API helpers throw.
 */
function refusal(status: number, reason: string): ApiException {
  return new ApiException({ status, message: 'refused', reason, fromServer: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  regionConfig.current = TWO_REGIONS;
  vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
  useCurrentUserStore.setState({
    user: { id: 'u1', name: 'foo', email: 'foo@bar.com', personalStudio: null, membershipTier: 'base' },
    role: null,
    loading: false,
    bootstrapped: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SlugSetupPage and the region', () => {
  it('places the personal Studio by time zone without showing a choice', async () => {
    inTimeZone('Asia/Singapore');
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null },
    });
    const user = userEvent.setup();
    setup();

    expect(screen.queryByRole('combobox')).toBeNull();
    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByTestId('studio-page')).toBeInTheDocument();
    expect(authApi.setupStudio).toHaveBeenCalledWith({ slug: 'my-handle', studioId: expect.stringMatching(UUID), region: 'sg' });
  });

  it('sends no region from a build with one region', async () => {
    regionConfig.current = null;
    inTimeZone('Asia/Singapore');
    vi.mocked(authApi.setupStudio).mockResolvedValueOnce({
      personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null },
    });
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByTestId('studio-page');
    const body = vi.mocked(authApi.setupStudio).mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('region');
    expect(body.studioId).toMatch(UUID);
  });

  it.each(['region_unavailable', 'studio_creation_in_progress'])(
    'says sign-up cannot finish right now on %s and retries the same creation on Continue',
    async (reason) => {
      inTimeZone('Asia/Singapore');
      vi.mocked(authApi.setupStudio)
        .mockRejectedValueOnce(refusal(reason === 'region_unavailable' ? 503 : 409, reason))
        .mockResolvedValueOnce({ personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null } });
      const user = userEvent.setup();
      setup();

      await user.type(screen.getByLabelText('Slug'), 'my-handle');
      await user.click(screen.getByRole('button', { name: 'Continue' }));
      expect(await screen.findByText('We can\'t finish signing you up right now. Please try again later.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Continue' }));

      await screen.findByTestId('studio-page');
      const [first, second] = vi.mocked(authApi.setupStudio).mock.calls.map((call) => call[0] as { studioId: string; region: string });
      expect(second!.studioId).toBe(first!.studioId);
      expect(second!.region).toBe('sg');
    },
  );

  it('resubmits once under a new id when the region already gave the creation up', async () => {
    inTimeZone('Asia/Singapore');
    vi.mocked(authApi.setupStudio)
      .mockRejectedValueOnce(refusal(409, 'studio_creation_abandoned'))
      .mockResolvedValueOnce({ personalStudio: { name: 'my-handle', slug: 'my-handle', avatarUrl: null } });
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByTestId('studio-page');
    await waitFor(() => expect(authApi.setupStudio).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(authApi.setupStudio).mock.calls.map((call) => call[0] as { studioId: string });
    expect(second!.studioId).not.toBe(first!.studioId);
  });

  it('generates a new id once the slug changes', async () => {
    inTimeZone('Asia/Singapore');
    vi.mocked(authApi.setupStudio)
      .mockRejectedValueOnce(refusal(503, 'region_unavailable'))
      .mockResolvedValueOnce({ personalStudio: { name: 'other', slug: 'other', avatarUrl: null } });
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('Slug'), 'my-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('We can\'t finish signing you up right now. Please try again later.');
    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'other-handle');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await screen.findByTestId('studio-page');
    const [first, second] = vi.mocked(authApi.setupStudio).mock.calls.map((call) => call[0] as { studioId: string });
    expect(second!.studioId).not.toBe(first!.studioId);
  });
});
