// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LangSwitcher } from '@web/features/preferences/LangSwitcher';
import { getLocale } from '@breatic/shared';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

// Shared language switcher (features/preferences) — rendered identically by
// the project AND studio top bars. The i18n engine is the single source of
// truth (no Zustand mirror — see `feedback_double_source_state_mirror_trap`).
describe('LangSwitcher', () => {
  beforeEach(() => {
    changeLocale('en');
  });

  afterEach(() => {
    // Reset both engine + persisted choice so a switched locale doesn't
    // leak into other suites via localStorage.
    changeLocale('en');
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
});
