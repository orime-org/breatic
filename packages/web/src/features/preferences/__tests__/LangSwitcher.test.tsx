// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { usersApi } from '@web/data/api/users';
import { toast } from '@web/lib/toast';
import { getLocale, t } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { useCurrentUserStore } from '@web/stores/current-user';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

// The account write is the network edge; the switch itself stays real.
vi.mock('@web/data/api/users', () => ({
  usersApi: { setLocale: vi.fn().mockResolvedValue({ locale: 'en' }) },
}));
vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn() } }));

// Shared language switcher (features/preferences) — rendered identically by
// the project AND studio top bars. The i18n engine is the single source of
// truth (no Zustand mirror — see `feedback_double_source_state_mirror_trap`).
/** Put a signed-in account in the store, as `ProtectedRoute` guarantees on app pages. */
function signIn(): void {
  useCurrentUserStore.setState({
    user: {
      id: 'user-1',
      name: 'Tester',
      email: 't@t.com',
      personalStudio: { name: 'Tester', slug: 'tester', avatarUrl: null },
      membershipTier: 'base',
    },
  });
}

describe('LangSwitcher', () => {
  beforeEach(() => {
    changeLocale('en');
    vi.mocked(usersApi.setLocale).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    // Reset both engine + persisted choice so a switched locale doesn't
    // leak into other suites via localStorage.
    changeLocale('en');
    useCurrentUserStore.setState({ user: null });
  });

  it('shows the active locale glyph on the trigger', () => {
    render(<LangSwitcher />);
    expect(screen.getByTestId('lang-trigger')).toHaveTextContent('EN');
  });

  it('aria-label reflects the active language', () => {
    render(<LangSwitcher />);
    expect(screen.getByLabelText('Language: English')).toBeInTheDocument();
  });

  it('opens the popover listing all five supported locales', async () => {
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    for (const code of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      expect(
        await screen.findByTestId(`lang-option-${code}`),
      ).toBeInTheDocument();
    }
  });

  it('marks the active locale past the fill the others take under the pointer', async () => {
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    expectChosenFill(await screen.findByTestId('lang-option-en'));
    expectHoverableSiblingFill(screen.getByTestId('lang-option-ja'));
  });

  it('selecting 简体中文 switches the active locale', async () => {
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    await user.click(await screen.findByTestId('lang-option-zh-CN'));
    expect(getLocale()).toBe('zh-CN');
  });

  it('has no a11y violations', async () => {
    const { container } = render(<LangSwitcher />);
    await expectNoA11yViolations(container);
  });
  it('keeps a signed-out visitor\'s choice on this device without writing to the account', async () => {
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    await user.click(await screen.findByTestId('lang-option-ja'));
    expect(getLocale()).toBe('ja');
    expect(localStorage.getItem('breatic.locale')).toBe('ja');
    expect(usersApi.setLocale).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('records the chosen language on the account', async () => {
    signIn();
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    await user.click(await screen.findByTestId('lang-option-ja'));
    expect(getLocale()).toBe('ja');
    expect(usersApi.setLocale).toHaveBeenCalledWith('ja');
  });

  it('keeps the new language on screen and says so when the account write fails', async () => {
    signIn();
    vi.mocked(usersApi.setLocale).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<LangSwitcher />);
    await user.click(screen.getByTestId('lang-trigger'));
    await user.click(await screen.findByTestId('lang-option-ko'));
    expect(getLocale()).toBe('ko');
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(t('chrome.languageNotSaved')),
    );
  });
});
