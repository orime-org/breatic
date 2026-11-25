// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { render, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { referral, options } = vi.hoisted(() => ({
  referral: { get: vi.fn() },
  options: vi.fn(),
}));

vi.mock('@web/data/api/referral', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  referralApi: referral,
}));
vi.mock('@web/data/api/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authApi: { options },
}));
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => 'CARRIED',
  forgetCarriedReferralCode: vi.fn(),
  forgetRefusedReferralCode: vi.fn(),
}));

import { ReferralCodeSection } from '@web/features/referral/ReferralCodeSection';
import { usePromoterEntry } from '@web/features/referral/use-promoter-entry';
import { useSignupReferral } from '@web/features/referral/use-signup-referral';
import { useCurrentUserStore } from '@web/stores';

/** A view every entry would show: the program is open and the account can still bind a code. */
const OPEN_VIEW = { canBind: true, binding: null, program: { open: true }, promoter: { state: 'none' } };

/**
 * A fresh query client around the children.
 * @returns The wrapper.
 */
function wrapper(): (props: { children: React.ReactNode }) => React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Let any query the render started settle.
 * @returns When pending timers and microtasks have run.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(() => {
  vi.clearAllMocks();
  referral.get.mockResolvedValue(OPEN_VIEW);
  options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
  useCurrentUserStore.setState({ user: { id: 'u1' } as never, role: null, loading: false, bootstrapped: true });
});

describe('the paused referral program (inner#2155)', () => {
  it('leaves the promoter entry out of the account menu and reads nothing', async () => {
    const { result } = renderHook(() => usePromoterEntry(true), { wrapper: wrapper() });
    await settle();
    expect(result.current.shown).toBe(false);
    expect(referral.get).not.toHaveBeenCalled();
  });

  it('hides the sign-up and sign-in code field, sends no code and reads no options for it', async () => {
    const { result } = renderHook(() => useSignupReferral(), { wrapper: wrapper() });
    await settle();
    expect(result.current.field).toBe('hidden');
    expect(result.current.body()).toEqual({});
    expect(options).not.toHaveBeenCalled();
  });

  it('draws no referral section in the membership panel and reads nothing', async () => {
    const Wrapper = wrapper();
    const { container } = render(<Wrapper><ReferralCodeSection /></Wrapper>);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(referral.get).not.toHaveBeenCalled();
  });
});
