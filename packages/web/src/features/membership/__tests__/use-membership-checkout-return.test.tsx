// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));

vi.mock('@web/data/api/subscription', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmMembershipCheckout: confirm,
}));
vi.mock('@web/stores/current-user', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshCurrentUser: vi.fn(async () => undefined),
}));

import { useMembershipCheckoutReturn } from '@web/features/membership/use-membership-checkout-return';
import { referralQueryKey } from '@web/features/referral/referral-query';
import { useCurrentUserStore } from '@web/stores';

beforeEach(() => {
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: { id: 'u1' } as never, role: null, loading: false, bootstrapped: true });
});

describe('returning from a membership checkout (inner#1868 §8)', () => {
  it('reads the referral view again, since the first-period discount may now be used', async () => {
    confirm.mockResolvedValue({ tier: 'pro', subscription: null, conversion: null });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/studio?membership=1&session_id=cs_1']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    renderHook(() => useMembershipCheckoutReturn(), { wrapper });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: referralQueryKey('u1') })));
  });
});
