// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { useSlugAvailability } from '@web/pages/studio/container/dialogs/use-slug-availability';
import { studiosApi } from '@web/data/api/studios';
import type { SlugAvailability } from '@web/data/api/studios';

vi.mock('@web/domain/use-debounce', () => ({
  useDebounce: <T,>(value: T): T => value,
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
  it('is idle for an empty slug and never calls the server', () => {
    const { result } = renderHook(() => useSlugAvailability(''), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('is invalid (no request) for a malformed slug', () => {
    const { result } = renderHook(() => useSlugAvailability('Bad Slug!'), {
      wrapper,
    });
    expect(result.current.status).toBe('invalid');
    expect(result.current.reason).toBe('format');
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('is invalid (no request) for a too-short slug', () => {
    const { result } = renderHook(() => useSlugAvailability('abc'), { wrapper });
    expect(result.current.status).toBe('invalid');
    expect(result.current.reason).toBe('length');
    expect(studiosApi.checkSlugAvailable).not.toHaveBeenCalled();
  });

  it('resolves available for a free, well-formed slug', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({ available: true });
    const { result } = renderHook(() => useSlugAvailability('nova-lab'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('available'));
  });

  it('resolves taken for an existing slug', async () => {
    vi.mocked(studiosApi.checkSlugAvailable).mockResolvedValue({
      available: false,
      reason: 'taken',
    });
    const { result } = renderHook(() => useSlugAvailability('acme-studio'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.status).toBe('taken'));
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
    await waitFor(() => expect(result.current.status).toBe('available'));

    // The stale alpha-one response arrives LATE — it must not flip the status
    // back to taken, because the hook renders the current slug's query.
    pending['alpha-one']!({ available: false, reason: 'taken' });
    await Promise.resolve();
    expect(result.current.status).toBe('available');
  });
});
