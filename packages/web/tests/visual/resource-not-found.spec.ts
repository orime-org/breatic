// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test, expect } from 'playwright/test';

const headings = {
  en: 'Page not found',
  'zh-CN': '页面未找到',
  'zh-TW': '頁面未找到',
  ja: 'ページが見つかりません',
  ko: '페이지를 찾을 수 없습니다',
};
for (const [locale, heading] of Object.entries(headings)) {
  for (const theme of ['light', 'dark']) {
    test(`404 renders ${locale} in ${theme}`, async ({ page }, testInfo) => {
      await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('breatic.locale', locale);
        localStorage.setItem('breatic.preferences', JSON.stringify({ state: { theme }, version: 1 }));
      }, { locale, theme });
      await page.goto('/missing-top-level');
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expect(page.getByRole('link')).toHaveAttribute('href', locale === 'en' ? '/' : `/${locale}/`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.screenshot({ path: testInfo.outputPath(`404-${locale}-${theme}.png`) });
    });
  }
}
