// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Page } from 'playwright/test';

/**
 * Switch the interface language through its menu; the account's choice outranks the browser's.
 * @param p - The page.
 * @param code - The locale to switch to.
 */
export async function switchLanguage(p: Page, code: string): Promise<void> {
  await p.getByTestId('lang-trigger').click();
  await expect(p.getByTestId('lang-popover')).toBeVisible();
  await p.getByTestId(`lang-option-${code}`).click();
  await expect(p.getByTestId('lang-popover')).toHaveCount(0);
}
