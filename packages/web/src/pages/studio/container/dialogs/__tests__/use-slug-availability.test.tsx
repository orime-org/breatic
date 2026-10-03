// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * useSlugAvailability — local validation gating + race-safety. The race test is
 * the critical one: while typing, a response for a slug the user has already
 * edited away from must NOT overwrite the current slug's status. React Query
 * keys the query by the slug, so a stale response lands under its own key and
 * the hook always renders the current slug's result. Debounce is mocked to be
 * instant here so the test drives the query directly.
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  slugFieldShowsConflict,
  useSlugAvailability,
  useSlugFieldShown,
} from '@web/pages/studio/container/dialogs/use-slug-availability';
import { ApiException } from '@web/data/api/types';
import { useDebounce } from '@web/lib/use-debounce';
import { studiosApi } from '@web/data/api/studios';
import type { SlugAvailability } from '@web/data/api/studios';

vi.mock('@web/lib/use-debounce', () => ({
  useDebounce: vi.fn(<T,>(value: T): T => value),
}));
vi.mock('@web/data/api/studios', () => ({
  studiosApi: { checkSlugAvailable: vi.fn() },
}));

/**
 * A React Query provider wrapper (retries off, so a single mocked response is
 * deterministic).
 * @param props the children to wrap.
 * @param props.children the subtree under the query client.
 * @returns the wrapped subtree.
 */
function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.mocked(studiosApi.checkSlugAvailable).mockReset();
});

describe('useSlugAvailability', () => {
  it('is empty for an empty slug and never calls the server', () => {
    const { result } = renderHook(() => useSlugAvailability(''), { wrapper });
    expect(result.current.state).toBe('empty');
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('is invalid (no request) for a malformed slug', () => {
    const { result } = renderHook(() => useSlugAvailability('Bad Slug!'), {
      wrapper,
    });
    expect(result.current).toEqual({ state: 'invalid', reason: 'format' });
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('is invalid (no request) for a too-short slug', () => {
    const { result } = renderHook(() => useSlugAvailability('abc'), { wrapper });
    expect(result.current).toEqual({ state: 'invalid', reason: 'length' });
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('resolves available for a free, well-formed slug', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({ available: true });
    const { result } = renderHook(() => useSlugAvailability('nova-lab'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.state).toBe('valid'));
  });

  it('resolves taken for an existing slug', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    const { result } = renderHook(() => useSlugAvailability('acme-studio'), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toEqual({ state: 'invalid', reason: 'taken' }));
  });

  it('reflects the CURRENT slug, not a stale in-flight one (race-safe)', async () => {
    const pending: Record<string, (v: SlugAvailability) => void> = {};
    vi.mocked(studiosApi.checkSlugAvailable).mockImplementation(
      (slug: string) =>
        new Promise<SlugAvailability>((resolve) => {
          pending[slug] = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      (slug: string) => useSlugAvailability(slug),
      { wrapper, initialProps: 'alpha-one' },
    );

    // The user edits the slug before the first check returns; alpha-two is now
    // the current input.
    rerender('alpha-two');

    // alpha-two (current) resolves available.
    pending['alpha-two']!({ available: true });
    await waitFor(() => expect(result.current.state).toBe('valid'));

    // The stale alpha-one response arrives LATE — it must not flip the status
    // back to taken, because the hook renders the current slug's query.
    pending['alpha-one']!({ available: false, reason: 'taken' });
    await Promise.resolve();
    expect(result.current.state).toBe('valid');
  });

  it('reports checking while the debounced value lags the live input (skew guard)', () => {
    // Simulate the 300ms debounce window: the live input is 'new-slug' but
    // useDebounce still returns the previous 'old-slug'. The gate must see
    // `checking`, not a stale `valid`, so a half-typed slug can't be
    // submitted with the previous slug's verdict.
    vi.mocked(useDebounce).mockReturnValueOnce('old-slug');
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({ available: true });
    const { result } = renderHook(() => useSlugAvailability('new-slug'), {
      wrapper,
    });
    expect(result.current.state).toBe('checking');
  });

  // The rename form starts out holding the studio's CURRENT slug. Asking the
  // server about it gets the truthful answer "taken" — by the very studio
  // doing the asking — which would block the form on its own initial state,
  // and would keep blocking it if the user edits and changes their mind.
  describe('own slug', () => {
    it('reports the caller\'s own slug as available without asking the server', () => {
      const { result } = renderHook(
        () => useSlugAvailability('my-studio', { ownSlug: 'my-studio' }),
        { wrapper },
      );
      expect(result.current.state).toBe('valid');
      expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
    });

    it('still asks about any OTHER slug', async () => {
      vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
        available: false,
        reason: 'taken',
      });
      const { result } = renderHook(
        () => useSlugAvailability('someone-else', { ownSlug: 'my-studio' }),
        { wrapper },
      );
      await waitFor(() => expect(result.current).toEqual({ state: 'invalid', reason: 'taken' }));
      expect(studiosApi.checkSlugAvailable).toHaveBeenCalledWith(
        'someone-else',
        expect.anything(),
      );
    });

    it('does not exempt an own slug that is reserved or malformed', () => {
      // The exemption says "this one is yours", not "skip validation" — a
      // studio holding a now-reserved slug still cannot re-submit it.
      const { result } = renderHook(
        () => useSlugAvailability('admin', { ownSlug: 'admin' }),
        { wrapper },
      );
      expect(result.current.state).toBe('invalid');
      expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
    });

    it('is unaffected when no own slug is given (the create dialogs)', async () => {
      vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
        available: false,
        reason: 'taken',
      });
      const { result } = renderHook(() => useSlugAvailability('my-studio'), {
        wrapper,
      });
      await waitFor(() => expect(result.current).toEqual({ state: 'invalid', reason: 'taken' }));
    });
  });
});

describe('slugFieldShowsConflict', () => {
  const conflict = new ApiException({ status: 409, message: 'Conflict' });

  /**
   * Render the live check for a slug on a client the test keeps, and wait
   * until the field has shown it as free.
   * @param slug - The slug in the field.
   * @returns The client and the hook result.
   */
  async function fieldShowingFree(slug: string): Promise<{
    client: QueryClient;
    result: { current: ReturnType<typeof useSlugAvailability> };
  }> {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const own = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValueOnce({
      available: true,
    });
    const { result } = renderHook(() => useSlugAvailability(slug), {
      wrapper: own,
    });
    await waitFor(() => expect(result.current.state).toBe('valid'));
    return { client, result };
  }

  it('re-asks the server and turns the same field red when the slug was taken', async () => {
    const { client, result } = await fieldShowingFree('nova-lab');
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValueOnce({
      available: false,
      reason: 'taken',
    });
    await expect(
      slugFieldShowsConflict(client, conflict, 'nova-lab', () => true),
    ).resolves.toBe(true);
    await waitFor(() =>
      expect(result.current).toEqual({ state: 'invalid', reason: 'taken' }),
    );
  });

  it('leaves the conflict to the caller when the slug is still free', async () => {
    const { client } = await fieldShowingFree('nova-lab');
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValueOnce({
      available: true,
    });
    await expect(
      slugFieldShowsConflict(client, conflict, 'nova-lab', () => true),
    ).resolves.toBe(false);
  });

  it('leaves a taken slug to the caller once the field is off screen', async () => {
    const { client } = await fieldShowingFree('nova-lab');
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValueOnce({
      available: false,
    });
    await expect(
      slugFieldShowsConflict(client, conflict, 'nova-lab', () => false),
    ).resolves.toBe(false);
  });

  it('leaves the conflict to the caller when the re-ask fails', async () => {
    const { client } = await fieldShowingFree('nova-lab');
    vi.mocked(studiosApi.checkSlugAvailable).mockRejectedValueOnce(
      new Error('offline'),
    );
    await expect(
      slugFieldShowsConflict(client, conflict, 'nova-lab', () => true),
    ).resolves.toBe(false);
  });

  it('does not re-ask for anything other than a 409', async () => {
    const client = new QueryClient();
    await expect(
      slugFieldShowsConflict(
        client,
        new ApiException({ status: 500, message: 'boom' }),
        'nova-lab',
        () => true,
      ),
    ).resolves.toBe(false);
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });
});

describe('useSlugFieldShown', () => {
  it('answers for the trimmed slug in an open field, and not once it closes or unmounts', () => {
    const { result, rerender, unmount } = renderHook(
      ({ open, slug }: { open: boolean; slug: string }) =>
        useSlugFieldShown(open, slug),
      { initialProps: { open: true, slug: ' nova-lab ' } },
    );
    const shows = result.current;
    expect(shows('nova-lab')).toBe(true);
    expect(shows('other-lab')).toBe(false);
    rerender({ open: false, slug: ' nova-lab ' });
    expect(shows('nova-lab')).toBe(false);
    rerender({ open: true, slug: 'nova-lab' });
    expect(shows('nova-lab')).toBe(true);
    unmount();
    expect(shows('nova-lab')).toBe(false);
  });
});
