// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Choosing where a new team Studio lives (inner#1955, acceptance 1 and 8,
 * demo sections 1 and 6). A build with several regions shows a Region select
 * under the Slug, defaulting from the browser's time zone; a build with one
 * region shows none and sends no region. The Studio id is made on the client
 * and reused while the form is unchanged, so a retry of the same create is
 * recognised; a create the region already gave up on is sent again once under
 * a new id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { NewStudioDialog } from '@web/pages/studio/container/dialogs/NewStudioDialog';
import { useCreateStudio } from '@web/pages/studio/container/dialogs/use-create-studio';
import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import { ApiException } from '@web/data/api/types';
import { getRegionConfig, parseRegionConfig } from '@web/data/api/regions';

vi.mock('@web/pages/studio/container/dialogs/use-slug-availability', async (importOriginal) => ({
  useSlugAvailability: vi.fn(),
  slugFieldShowsConflict: vi.fn(async () => false),
  useSlugFieldShown: (await importOriginal<
    typeof import('@web/pages/studio/container/dialogs/use-slug-availability')
  >()).useSlugFieldShown,
}));
vi.mock('@web/pages/studio/container/dialogs/use-create-studio');
vi.mock('@web/data/api/regions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/regions')>()),
  getRegionConfig: vi.fn(),
}));

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const mutate = vi.fn();

/**
 * Pretend the browser is in a time zone.
 * @param timeZone - The IANA zone.
 */
function inTimeZone(timeZone: string): void {
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone };
  });
}

/**
 * Render the dialog open inside a query client.
 * @returns The render result.
 */
function renderDialog(): ReturnType<typeof render> {
  const ui: ReactElement = (
    <QueryClientProvider client={new QueryClient()}>
      <NewStudioDialog open onOpenChange={() => {}} />
    </QueryClientProvider>
  );
  return render(ui);
}

/**
 * Fill the name and slug and press Create.
 * @param user - The user-event session.
 * @param slug - The slug to type.
 */
async function fillAndCreate(user: ReturnType<typeof userEvent.setup>, slug = 'nova-lab'): Promise<void> {
  await user.type(screen.getByLabelText('Name'), 'Nova');
  await user.type(screen.getByLabelText('Slug'), slug);
  await user.click(screen.getByRole('button', { name: 'Create' }));
}

/**
 * The body of the n-th create.
 * @param n - Which create, from 0.
 * @returns The body passed to `mutate`.
 */
function bodyOf(n: number): Record<string, unknown> {
  return mutate.mock.calls[n]![0] as Record<string, unknown>;
}

/**
 * Answer the n-th create with a refusal.
 * @param n - Which create, from 0.
 * @param status - The HTTP status.
 * @param reason - The server's `error.reason`.
 */
async function refuse(n: number, status: number, reason: string): Promise<void> {
  const { onError } = mutate.mock.calls[n]![1] as { onError: (err: unknown) => void };
  await act(async () => {
    onError(new ApiException({ status, message: `server says ${reason}`, reason, fromServer: true }));
  });
}

beforeEach(() => {
  mutate.mockReset();
  vi.mocked(useCreateStudio).mockReturnValue({
    mutate,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateStudio>);
  vi.mocked(useSlugAvailability).mockReturnValue({ state: 'valid' });
  vi.mocked(getRegionConfig).mockReturnValue(TWO_REGIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('NewStudioDialog — the Region select', () => {
  it('defaults to Singapore in an Asian time zone and sends it with a fresh Studio id', async () => {
    inTimeZone('Asia/Singapore');
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByRole('combobox', { name: 'Region' })).toHaveTextContent('Singapore');
    await fillAndCreate(user);

    expect(bodyOf(0)).toEqual({ name: 'Nova', slug: 'nova-lab', studioId: expect.stringMatching(UUID), region: 'sg' });
  });

  it('defaults to US West elsewhere and sends the region the user picks', async () => {
    inTimeZone('America/New_York');
    const user = userEvent.setup();
    renderDialog();

    const select = screen.getByRole('combobox', { name: 'Region' });
    expect(select).toHaveTextContent('US West');
    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Singapore' }));
    await fillAndCreate(user);

    expect(bodyOf(0).region).toBe('sg');
  });

  it('shows no Region select and sends no region in a build with one region', async () => {
    vi.mocked(getRegionConfig).mockReturnValue(null);
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByRole('combobox', { name: 'Region' })).not.toBeInTheDocument();
    await fillAndCreate(user);

    expect(bodyOf(0)).toEqual({ name: 'Nova', slug: 'nova-lab', studioId: expect.stringMatching(UUID) });
  });
});

describe('NewStudioDialog — when the region cannot take the Studio', () => {
  it('says the region cannot create right now, and a retry of the same form keeps the Studio id', async () => {
    inTimeZone('Asia/Singapore');
    const user = userEvent.setup();
    renderDialog();
    await fillAndCreate(user);
    await refuse(0, 503, 'region_unavailable');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Studios can\'t be created in this region right now. Please try again later, or pick another region.',
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(bodyOf(1).studioId).toBe(bodyOf(0).studioId);
  });

  it('says the last create is still in progress', async () => {
    inTimeZone('Asia/Singapore');
    const user = userEvent.setup();
    renderDialog();
    await fillAndCreate(user);
    await refuse(0, 409, 'studio_creation_in_progress');

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your last Studio is still being created. Please try again later.',
    );
  });

  it('makes a new Studio id once the slug changes', async () => {
    inTimeZone('Asia/Singapore');
    const user = userEvent.setup();
    renderDialog();
    await fillAndCreate(user);
    await refuse(0, 503, 'region_unavailable');

    await user.type(screen.getByLabelText('Slug'), 'x');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(bodyOf(1).slug).toBe('nova-labx');
    expect(bodyOf(1).studioId).not.toBe(bodyOf(0).studioId);
  });

  it('sends a create the region gave up on once more under a new id, with no message', async () => {
    inTimeZone('Asia/Singapore');
    const user = userEvent.setup();
    renderDialog();
    await fillAndCreate(user);
    await refuse(0, 409, 'studio_creation_abandoned');

    expect(mutate).toHaveBeenCalledTimes(2);
    expect(bodyOf(1)).toEqual({ ...bodyOf(0), studioId: expect.stringMatching(UUID) });
    expect(bodyOf(1).studioId).not.toBe(bodyOf(0).studioId);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
