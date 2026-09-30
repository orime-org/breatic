// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setLocale, t, type Locale } from '@breatic/shared';
import { bootstrapLocale } from '@web/i18n/locale-bootstrap';
import NotFoundPage from '../NotFoundPage';

bootstrapLocale();
afterEach(() => { cleanup(); setLocale('en'); });
it.each<Locale>(['en', 'zh-CN', 'zh-TW', 'ja', 'ko'])('renders %s with a localized home link', locale => {
  setLocale(locale);
  render(<NotFoundPage />);
  expect(screen.getByText('404')).toBeVisible();
  expect(screen.getByRole('heading')).toHaveTextContent(t('notFound.heading'));
  expect(screen.getByText(t('notFound.body'))).toBeVisible();
  expect(screen.getByRole('link')).toHaveAttribute('href', locale === 'en' ? '/' : `/${locale}/`);
});
