// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
// The real switch by default; a case that needs a download in flight hands the
// switcher a promise it settles itself.
vi.mock('@web/i18n/locale-bootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/i18n/locale-bootstrap')>();
  return { ...actual, changeLocale: vi.fn(actual.changeLocale) };
});

/** What `changeLocale` settles with. */
type SwitchResult = Awaited<ReturnType<typeof changeLocale>>;

interface HeldSwitch {
  settle: (result: SwitchResult) => Promise<void>;
}

/**
 * Make the next `changeLocale` call wait until the case settles it.
 * @returns A handle that settles the call inside `act`.
 */
function holdNextSwitch(): HeldSwitch {
  let resolve!: (result: SwitchResult) => void;
  const promise = new Promise<SwitchResult>((r) => {
    resolve = r;
  });
  vi.mocked(changeLocale).mockImplementationOnce(() => promise);
  return {
    settle: async (result) => {
      await act(async () => {
        resolve(result);
        await promise;
      });
    },
  };
}

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

// Shared language switcher (features/preferences) — rendered identically by
// the project and studio top bars and the page header of every page framed by
// AuthCardShell. The i18n engine is the single source of
// truth (no Zustand mirror; see
// .claude/skills/react-state-traps/SKILL.md#do-not-mirror-engine-state-in-zustand).
describe('LangSwitcher', () => {
  beforeEach(() => {
    vi.mocked(changeLocale).mockReset();
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
    // The account write follows the switch's result, a promise.
    await vi.waitFor(() => expect(usersApi.setLocale).toHaveBeenCalledWith('ja'));
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

  describe('while the picked language downloads', () => {
    it('keeps the menu open with the picked item loading', async () => {
      holdNextSwitch();
      const user = userEvent.setup();
      render(<LangSwitcher />);
      await user.click(screen.getByTestId('lang-trigger'));
      await user.click(await screen.findByTestId('lang-option-ja'));

      expect(screen.getByTestId('lang-popover')).toBeInTheDocument();
      expect(screen.getByTestId('lang-option-ja')).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('lang-option-ko')).not.toHaveAttribute('aria-busy');
    });

    it('closes the menu and writes the account once the switch lands', async () => {
      signIn();
      const ja = holdNextSwitch();
      const user = userEvent.setup();
      render(<LangSwitcher />);
      await user.click(screen.getByTestId('lang-trigger'));
      await user.click(await screen.findByTestId('lang-option-ja'));
      expect(screen.getByTestId('lang-popover')).toBeInTheDocument();
      expect(usersApi.setLocale).not.toHaveBeenCalled();

      await ja.settle('switched');

      await vi.waitFor(() => expect(screen.queryByTestId('lang-popover')).not.toBeInTheDocument());
      expect(usersApi.setLocale).toHaveBeenCalledExactlyOnceWith('ja');
    });

    it('says so, keeps the menu open and writes nothing to the account when the download fails', async () => {
      signIn();
      const ja = holdNextSwitch();
      const user = userEvent.setup();
      render(<LangSwitcher />);
      await user.click(screen.getByTestId('lang-trigger'));
      await user.click(await screen.findByTestId('lang-option-ja'));

      await ja.settle('failed');

      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(t('chrome.languageLoadFailed')),
      );
      expect(screen.getByTestId('lang-popover')).toBeInTheDocument();
      expect(screen.getByTestId('lang-option-ja')).not.toHaveAttribute('aria-busy');
      expect(usersApi.setLocale).not.toHaveBeenCalled();
    });

    it('follows the last pick: an earlier pick superseded by it says nothing and writes nothing', async () => {
      signIn();
      const ja = holdNextSwitch();
      const ko = holdNextSwitch();
      const user = userEvent.setup();
      render(<LangSwitcher />);
      await user.click(screen.getByTestId('lang-trigger'));
      await user.click(await screen.findByTestId('lang-option-ja'));
      await user.click(screen.getByTestId('lang-option-ko'));

      await ja.settle('superseded');
      expect(screen.getByTestId('lang-popover')).toBeInTheDocument();
      expect(screen.getByTestId('lang-option-ko')).toHaveAttribute('aria-busy', 'true');

      await ko.settle('switched');

      await vi.waitFor(() => expect(screen.queryByTestId('lang-popover')).not.toBeInTheDocument());
      expect(toast.error).not.toHaveBeenCalled();
      expect(usersApi.setLocale).toHaveBeenCalledExactlyOnceWith('ko');
    });

    it('lets a switch from outside the menu supersede the pick and closes quietly', async () => {
      signIn();
      const ja = holdNextSwitch();
      const user = userEvent.setup();
      render(<LangSwitcher />);
      await user.click(screen.getByTestId('lang-trigger'));
      await user.click(await screen.findByTestId('lang-option-ja'));

      // The account's language read at sign-in lands while ja downloads.
      act(() => {
        void changeLocale('ko');
      });
      await ja.settle('superseded');

      await vi.waitFor(() => expect(screen.queryByTestId('lang-popover')).not.toBeInTheDocument());
      expect(toast.error).not.toHaveBeenCalled();
      expect(usersApi.setLocale).not.toHaveBeenCalled();

      await user.click(screen.getByTestId('lang-trigger'));
      expect(await screen.findByTestId('lang-option-ja')).not.toHaveAttribute('aria-busy');
      expect(screen.getByTestId('lang-trigger')).toHaveTextContent('한');
    });
  });
});
