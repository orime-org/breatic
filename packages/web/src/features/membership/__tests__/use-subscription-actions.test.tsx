// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the panel does when the server refuses an action because the account
 * is not in the state the panel showed (#307 A10b).
 *
 * A refused checkout is the case that matters: before refusing, the server
 * asked Stripe about a subscription the panel was showing as ended, found it
 * still live and stored it. The panel and the avatar menu then have to show
 * that, or the reader keeps looking at a tier and buttons the server no
 * longer agrees with.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  startSubscriptionCheckout: vi.fn(),
  changeSubscriptionPlan: vi.fn(),
  cancelSubscription: vi.fn(),
  resumeSubscription: vi.fn(),
}));
vi.mock('@web/data/api/subscription', () => api);

const refreshCurrentUser = vi.hoisted(() => vi.fn());
vi.mock('@web/stores/current-user', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/stores/current-user')>()),
  refreshCurrentUser,
}));

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { useSubscriptionActions } from '@web/features/membership/use-subscription-actions';

/** The rendered hook and the client it reads through. */
interface Rendered {
  result: { current: ReturnType<typeof useSubscriptionActions> };
  client: QueryClient;
}

/**
 * Renders the hook inside a query client of its own.
 * @returns The hook result and the query client.
 */
function setup(): Rendered {
  const client = new QueryClient();
  /**
   * Provides the client to the hook.
   * @param props - The children to wrap.
   * @param props.children - The hook's test host.
   * @returns The provider.
   */
  function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(() => useSubscriptionActions(null), { wrapper: Wrapper });
  return { result, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSubscriptionActions — a refusal re-reads the account (#307 A10b)', () => {
  it('re-reads the panel and the avatar menu when a checkout is refused as a conflict', async () => {
    api.startSubscriptionCheckout.mockRejectedValue({
      status: 409,
      message: 'already subscribed',
      fromServer: true,
    });
    const { result, client } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    act(() => {
      result.current.choose({ tier: 'pro', period: 'month' });
    });

    await waitFor(() => {
      expect(refreshCurrentUser).toHaveBeenCalled();
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['account', 'membership'] });
  });

  it('leaves the account alone when a checkout fails for any other reason', async () => {
    api.startSubscriptionCheckout.mockRejectedValue({
      status: 503,
      message: 'down',
      fromServer: true,
    });
    const { result } = setup();

    act(() => {
      result.current.choose({ tier: 'pro', period: 'month' });
    });

    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
    expect(refreshCurrentUser).not.toHaveBeenCalled();
  });
});
