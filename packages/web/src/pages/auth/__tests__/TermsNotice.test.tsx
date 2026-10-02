// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The terms line at the foot of the sign-in and sign-up cards (#302).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setLocale } from '@breatic/shared';

import { TermsNotice } from '@web/pages/auth/_shared/TermsNotice';
import { OFFICIAL_HOME_URL, PRIVACY_URL, TERMS_URL } from '@web/lib/official-home';

afterEach(() => {
  setLocale('en');
});

describe('TermsNotice', () => {
  it('says continuing agrees to the terms and acknowledges the privacy policy', () => {
    render(<TermsNotice />);
    expect(screen.getByTestId('auth-terms-notice')).toHaveTextContent(
      'By continuing, you agree to our Terms of Service and acknowledge our Privacy Policy.',
    );
  });

  it('links each document on the marketing site', () => {
    render(<TermsNotice />);
    expect(TERMS_URL).toBe(`${OFFICIAL_HOME_URL}terms/`);
    expect(PRIVACY_URL).toBe(`${OFFICIAL_HOME_URL}privacy/`);
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', TERMS_URL);
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', PRIVACY_URL);
  });

  it('opens each document in a new tab so the form keeps what was typed', () => {
    render(<TermsNotice />);
    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('follows the interface language, link names included', () => {
    setLocale('zh-CN');
    render(<TermsNotice />);
    expect(screen.getByTestId('auth-terms-notice')).toHaveTextContent(
      '继续即表示你同意使用条款，并已阅读隐私政策。',
    );
    expect(screen.getByRole('link', { name: '使用条款' })).toHaveAttribute('href', TERMS_URL);
    expect(screen.getByRole('link', { name: '隐私政策' })).toHaveAttribute('href', PRIVACY_URL);
  });
});
