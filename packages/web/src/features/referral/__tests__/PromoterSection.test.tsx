// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { api, toasts } = vi.hoisted(() => ({
  api: { get: vi.fn(), bind: vi.fn(), apply: vi.fn() },
  toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@web/data/api/referral', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  referralApi: api,
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/lib/toast')>();
  return { ...actual, toast: { ...actual.toast, ...toasts } };
});

import { PromoterSection } from '@web/features/referral/PromoterSection';
import type { AccountReferral } from '@web/data/api/referral';
import { ApiException } from '@web/data/api/types';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores';

const OPEN: AccountReferral = {
  firstPeriodDiscountPercent: 20,
  binding: null,
  canBind: true,
  program: { open: true, termsVersion: '2026-11-07' },
  promoter: { state: 'none' },
};

/**
 * Renders the section over one view.
 * @param view - What the server answers.
 */
function setup(view: AccountReferral): void {
  api.get.mockResolvedValue(view);
  mount();
}

/** Renders the section over whatever the read is set to answer. */
function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PromoterSection />
    </QueryClientProvider>,
  );
}

/**
 * A server refusal.
 * @param reason - The refusal code.
 * @param details - Other fields of the error body.
 * @returns The exception.
 */
function refusal409(reason: string, details: Record<string, unknown> = {}): ApiException {
  return new ApiException({ status: 409, message: `refused ${reason}`, fromServer: true, reason, details: { reason, ...details } });
}

/**
 * Fills the application form.
 * @param user - The user-event instance.
 */
async function fillForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: 'Country or region' }));
  await user.click(await screen.findByRole('option', { name: 'Singapore' }));
  await user.type(screen.getByPlaceholderText(/youtube/i), 'https://youtube.com/@me');
  await user.type(screen.getByLabelText('How you will promote'), 'Tutorials for designers');
}

beforeEach(() => {
  vi.clearAllMocks();
  useCurrentUserStore.setState({ user: { id: 'u1' } as never, role: null, loading: false, bootstrapped: true });
});
afterEach(() => {
  resetRunOnceForTests();
});

describe('the promoter program section (inner#1868 table 12.11)', () => {
  it('shows a skeleton on the first read', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByTestId('promoter-loading')).toBeInTheDocument();
  });

  it('shows a failed first read with a retry that reads again', async () => {
    api.get
      .mockRejectedValueOnce(new ApiException({ status: 500, message: 'down', fromServer: true }))
      .mockResolvedValueOnce({ ...OPEN, program: { open: false, termsVersion: '' } });
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Promoter applications are not open yet.')).toBeInTheDocument();
  });

  it('draws nothing while payments are off', async () => {
    api.get.mockRejectedValue(new ApiException({ status: 404, message: 'off', fromServer: true }));
    mount();
    await waitFor(() => expect(screen.queryByTestId('promoter-loading')).toBeNull());
    expect(screen.queryByText('Promoter program')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says applications are not open yet', async () => {
    setup({ ...OPEN, program: { open: false, termsVersion: '' } });
    expect(await screen.findByText('Promoter applications are not open yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply to become a promoter' })).toBeNull();
  });

  it('offers the application while open', async () => {
    setup(OPEN);
    expect(await screen.findByRole('button', { name: 'Apply to become a promoter' })).toBeInTheDocument();
  });

  it('shows an application under review', async () => {
    setup({ ...OPEN, promoter: { state: 'pending', submittedAt: '2026-11-07T08:00:00.000Z' } });
    expect(await screen.findByText('Application under review')).toBeInTheDocument();
  });

  it('shows a rejection with its note, and offers to apply again only while open', async () => {
    setup({ ...OPEN, promoter: { state: 'rejected', decidedAt: '2026-11-07T08:00:00.000Z', note: 'Links did not open.' } });
    expect(await screen.findByText(/Links did not open\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply again' })).toBeInTheDocument();
  });

  it('shows a rejection without a way to reapply while closed', async () => {
    setup({ ...OPEN, program: { open: false, termsVersion: '' }, promoter: { state: 'rejected', decidedAt: '2026-11-07T08:00:00.000Z', note: null } });
    expect(await screen.findByText('Your last application was not approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply again' })).toBeNull();
  });

  it('shows an approved promoter the code and link with copy buttons', async () => {
    setup({ ...OPEN, promoter: { state: 'approved', code: 'ALICE', link: 'https://app.example/register?ref=ALICE', codeStatus: 'active' } });
    expect(await screen.findByText('ALICE')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://app.example/register?ref=ALICE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('copies the link and says so', async () => {
    const user = userEvent.setup();
    setup({ ...OPEN, promoter: { state: 'approved', code: 'ALICE', link: 'https://app.example/register?ref=ALICE', codeStatus: 'active' } });
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Copied'));
    expect(await navigator.clipboard.readText()).toBe('https://app.example/register?ref=ALICE');
  });

  it('says so when the browser refuses the copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    setup({ ...OPEN, promoter: { state: 'approved', code: 'ALICE', link: 'https://app.example/register?ref=ALICE', codeStatus: 'active' } });
    await user.click(await screen.findByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not copy to clipboard.'));
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it('shows a disabled code as disabled, without the link', async () => {
    setup({ ...OPEN, promoter: { state: 'approved', code: 'ALICE', link: 'https://app.example/register?ref=ALICE', codeStatus: 'disabled' } });
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText(/This code is disabled/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
  });

  it('shows a removed promoter that they are no longer in the program', async () => {
    setup({ ...OPEN, promoter: { state: 'approved', code: 'ALICE', link: 'https://app.example/register?ref=ALICE', codeStatus: 'removed' } });
    expect(await screen.findByText(/no longer in the promoter program/)).toBeInTheDocument();
  });
});

describe('the application dialog (inner#1868 table 12.12)', () => {
  it('scrolls the form inside the dialog, keeping the title and buttons on screen', async () => {
    // Up to ten channel rows can make the form taller than a laptop screen.
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    const viewport = screen.getByLabelText('Country or region').closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport!.contains(screen.getByRole('button', { name: 'Submit application' }))).toBe(false);
    expect(viewport!.contains(screen.getByRole('heading', { name: 'Apply to become a promoter' }))).toBe(false);
  });

  it('names every missing field instead of sending', async () => {
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    expect(screen.getByText('Choose a country or region.')).toBeInTheDocument();
    expect(screen.getByText('Add at least one channel.')).toBeInTheDocument();
    expect(screen.getByText('Describe how you will promote.')).toBeInTheDocument();
    expect(screen.getByText('Agree to the promoter terms to apply.')).toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('locks the form while the application is being sent, so what is sent is what shows', async () => {
    api.apply.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalled());
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByLabelText('Country or region')).toBeDisabled();
    expect(screen.getByLabelText('How you will promote')).toBeDisabled();
    for (const input of screen.getAllByRole('textbox').filter((el) => el.tagName === 'INPUT')) expect(input).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add another' })).toBeDisabled();
    // Radix Select opens on pointerdown, which a disabled fieldset does not stop.
    await user.click(screen.getByLabelText('Country or region'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the application being sent after the panel is closed and opened again, and tells a refusal that arrives meanwhile', async () => {
    let refuse: (err: unknown) => void = () => undefined;
    api.apply.mockReturnValue(new Promise((_, reject) => { refuse = reject; }));
    const user = userEvent.setup();
    api.get.mockResolvedValue(OPEN);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = render(<QueryClientProvider client={client}><PromoterSection /></QueryClientProvider>);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalled());
    first.unmount();

    render(<QueryClientProvider client={client}><PromoterSection /></QueryClientProvider>);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    expect(screen.getByRole('combobox', { name: 'Country or region' })).toHaveTextContent('Singapore');
    expect(screen.getByLabelText('How you will promote')).toHaveValue('Tutorials for designers');
    expect(screen.getByDisplayValue('https://youtube.com/@me')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeChecked();

    await act(async () => { refuse(refusal409('terms_changed', { termsVersion: '2026-12-01' })); });
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledWith('The promoter terms have been updated. Read them again, then agree.'));
  });

  it('asks for agreement to the terms before sending', async () => {
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    expect(screen.getByText('Agree to the promoter terms to apply.')).toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it('files the application with the current terms version and shows it under review', async () => {
    api.apply.mockResolvedValue({ ...OPEN, promoter: { state: 'pending', submittedAt: '2026-11-07T08:00:00.000Z' } });
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(
      { country: 'SG', channels: ['https://youtube.com/@me'], plan: 'Tutorials for designers', termsVersion: '2026-11-07' },
      expect.any(String),
    ));
    expect(await screen.findByText('Application under review')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toasts.success).toHaveBeenCalled();
  });

  it('sends the application again with the same key after a throttle, and files it', async () => {
    api.apply
      .mockRejectedValueOnce(new ApiException({ status: 429, message: 'slow down', fromServer: true, retryAfterSeconds: 0 }))
      .mockResolvedValueOnce({ ...OPEN, promoter: { state: 'pending', submittedAt: '2026-11-07T10:00:00.000Z' } });
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(api.apply).toHaveBeenCalledTimes(2);
    expect(api.apply.mock.calls[1]![1]).toBe(api.apply.mock.calls[0]![1]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it('unticks the terms and says they changed when the version moved on', async () => {
    api.apply.mockRejectedValueOnce(refusal409('terms_changed', { termsVersion: '2026-12-01' }));
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    expect(await screen.findByText('The promoter terms have been updated. Read them again, then agree.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Agreeing again agrees to the version the answer named, whatever the panel last read.
    api.apply.mockResolvedValueOnce({ ...OPEN, promoter: { state: 'pending', submittedAt: '2026-11-07T10:00:00.000Z' } });
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(2));
    expect(api.apply.mock.calls[1]![0]).toMatchObject({ termsVersion: '2026-12-01' });
  });

  it.each(['program_closed', 'already_promoter'])('closes, toasts and reads the section again on %s', async (reason) => {
    api.apply.mockRejectedValue(refusal409(reason));
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(`refused ${reason}`));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.get.mock.calls.length).toBeGreaterThan(1);
  });

  it('closes, toasts and reads the section again when an application is already under review', async () => {
    api.apply.mockRejectedValue(refusal409('application_pending'));
    const user = userEvent.setup();
    setup(OPEN);
    await user.click(await screen.findByRole('button', { name: 'Apply to become a promoter' }));
    await fillForm(user);
    await user.click(screen.getByRole('checkbox'));
    api.get.mockResolvedValue({ ...OPEN, promoter: { state: 'pending', submittedAt: '2026-11-07T08:00:00.000Z' } });
    await user.click(screen.getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('refused application_pending'));
    expect(await screen.findByText('Application under review')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
