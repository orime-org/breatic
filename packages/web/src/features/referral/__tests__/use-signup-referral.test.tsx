// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { options, carry } = vi.hoisted(() => ({
  options: vi.fn(),
  carry: { code: null as string | null, forget: vi.fn(), refused: vi.fn() },
}));

vi.mock('@web/data/api/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authApi: { options },
}));
vi.mock('@web/lib/referral-carry', () => ({
  carriedReferralCode: () => carry.code,
  forgetCarriedReferralCode: () => {
    carry.forget();
    carry.code = null;
  },
  forgetRefusedReferralCode: (code: string) => carry.refused(code),
}));

import { useSignupReferral } from '@web/features/referral/use-signup-referral';

/**
 * Renders the hook inside a fresh query client.
 * @returns The hook's result holder.
 */
function render(): ReturnType<typeof renderHook<ReturnType<typeof useSignupReferral>, unknown>> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSignupReferral(), { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  carry.code = null;
});

describe('useSignupReferral (inner#1868 §10, table 12.13)', () => {
  it('waits for the deployment options before showing the field', async () => {
    let resolve!: (v: { emailVerification: boolean; referralEnabled: boolean }) => void;
    options.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = render();
    expect(result.current.field).toBe('loading');
    act(() => resolve({ emailVerification: false, referralEnabled: true }));
    await waitFor(() => expect(result.current.field).toBe('shown'));
  });

  it('shows the field when the options cannot be read', async () => {
    options.mockRejectedValue(new Error('offline'));
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
  });

  it('hides the field and sends nothing while payments are off', async () => {
    carry.code = 'ALICE';
    options.mockResolvedValue({ emailVerification: false, referralEnabled: false });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('hidden'));
    expect(result.current.body()).toEqual({});
  });

  it('pre-fills the carried code as from the link, and typing makes it typed', async () => {
    carry.code = 'ALICE';
    options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
    expect(result.current.value).toBe('ALICE');
    expect(result.current.body()).toEqual({ referralCode: 'ALICE', referralSource: 'signup_link' });
    act(() => result.current.change('bob'));
    expect(result.current.body()).toEqual({ referralCode: 'bob', referralSource: 'signup_typed' });
  });

  it('sends nothing for an empty or blank field', async () => {
    options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
    expect(result.current.body()).toEqual({});
    act(() => result.current.change('   '));
    expect(result.current.body()).toEqual({});
  });

  it('shows a refusal under the field and names the refused code to the carried one; typing clears the error', async () => {
    carry.code = 'ALICE';
    options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
    act(() => result.current.refused('That code is not valid.'));
    expect(result.current.error).toBe('That code is not valid.');
    expect(carry.refused).toHaveBeenCalledWith('ALICE');
    expect(carry.forget).not.toHaveBeenCalled();
    act(() => result.current.change('ALICE2'));
    expect(result.current.error).toBeNull();
  });

  it('names what the visitor typed when that is what was refused', async () => {
    carry.code = 'ALICE';
    options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
    act(() => result.current.change('BOB'));
    act(() => result.current.refused('That code is not valid.'));
    expect(carry.refused).toHaveBeenCalledWith('BOB');
  });

  it('forgets the carried code once a sign-up succeeded', async () => {
    carry.code = 'ALICE';
    options.mockResolvedValue({ emailVerification: false, referralEnabled: true });
    const { result } = render();
    await waitFor(() => expect(result.current.field).toBe('shown'));
    act(() => result.current.used());
    expect(carry.forget).toHaveBeenCalledTimes(1);
  });
});
