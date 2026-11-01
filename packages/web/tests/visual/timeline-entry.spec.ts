// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Timeline entry, localized material controls and desktop layout (inner#1707). */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locale } from '@breatic/shared';
import { expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { watchTimelineErrors } from '../helpers/timeline-media';

/** Existing theme intents offered by the Project's theme menu. */
type ThemeMode = 'light' | 'dark' | 'system';

/** Localized strings exercised by the entry and its material form. */
interface TimelineCopy {
  empty: string;
  addMedia: string;
  visualTrack: string;
  play: string;
  startFrame: string;
  cancel: string;
  material: { project: string; local: string; loading: string; fileEmpty: string; chooseFile: string; confirm: string };
}

/** Actual rendered geometry and document-level horizontal overflow. */
interface LayoutReading {
  viewport: { width: number; height: number };
  box: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  pageOverflowX: number;
}

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;
const THEMES = ['light', 'dark'] as const;

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Read the checked-in locale without duplicating translated product copy in this test.
 * @throws {Error} When the locale cannot be read or parsed.
 */
function timelineCopy(locale: Locale): TimelineCopy {
  return (JSON.parse(readFileSync(resolve(__dirname, '../../../../locales', `${locale}.json`), 'utf8')) as { timeline: TimelineCopy }).timeline;
}

/**
 * Use the existing language menu and wait until the account has accepted its new locale.
 * @throws {Error} When the real menu or account write fails.
 */
async function switchLanguage(page: Page, locale: Locale): Promise<void> {
  await page.getByTestId('lang-trigger').click();
  await expect(page.getByTestId('lang-popover')).toBeVisible();
  const accepted = page.waitForResponse((response) => response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === '/api/v1/users/me/locale');
  await page.getByTestId(`lang-option-${locale}`).click();
  await expect(page.getByTestId('lang-popover')).toHaveCount(0);
  const response = await accepted;
  expect(response.status(), 'persist the chosen account language').toBe(200);
  expect(await response.json()).toMatchObject({ data: { locale } });
}

/**
 * Change the real theme preference using the same menu as the existing preference smoke test.
 * @throws {Error} When the theme menu or persisted intent does not update.
 */
async function switchTheme(page: Page, theme: ThemeMode): Promise<void> {
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-popover')).toBeVisible();
  await page.getByTestId(`theme-option-${theme}`).click();
  await expect(page.getByTestId('theme-popover')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('breatic.theme'))).toBe(theme);
  if (theme !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/**
 * Finish the element's own entry animations before observing viewport geometry.
 * @throws {Error} When an animation is canceled or never finishes.
 */
async function settle(element: Locator): Promise<void> {
  await element.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
}

/**
 * Measure the rendered surface and its document, without prescribing new design dimensions.
 * @throws {Error} When the element cannot be evaluated.
 */
async function readLayout(element: Locator): Promise<LayoutReading> {
  return element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const scroller = document.scrollingElement ?? document.documentElement;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      pageOverflowX: scroller.scrollWidth - scroller.clientWidth,
    };
  });
}

/**
 * Keep an actually rendered surface inside the desktop viewport with no page-level horizontal overflow.
 * @throws {Error} When content is outside the viewport or causes unexpected horizontal scrolling.
 */
function expectViewportFit(layout: LayoutReading): void {
  expect(layout.box.width).toBeGreaterThan(0);
  expect(layout.box.height).toBeGreaterThan(0);
  // One CSS pixel allows fractional layout rounding, rather than fixing a modal size.
  expect(layout.box.left).toBeGreaterThanOrEqual(-1);
  expect(layout.box.top).toBeGreaterThanOrEqual(-1);
  expect(layout.box.right).toBeLessThanOrEqual(layout.viewport.width + 1);
  expect(layout.box.bottom).toBeLessThanOrEqual(layout.viewport.height + 1);
  expect(layout.pageOverflowX).toBeLessThanOrEqual(1);
}

/**
 * Measure all visible form operations and verify their centers receive real pointer hits.
 * @throws {Error} When a form operation is clipped, covered or outside the viewport.
 */
async function expectDialogOperations(dialog: Locator): Promise<LayoutReading> {
  await settle(dialog);
  const layout = await readLayout(dialog);
  expectViewportFit(layout);
  const controls = dialog.locator('button, input:not([type="file"])');
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    await expect(control).toBeVisible();
    expectViewportFit(await readLayout(control));
    const reading = await control.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { receivesPointer: hit !== null && node.contains(hit), overflowX: node.scrollWidth - node.clientWidth };
    });
    expect(reading.receivesPointer).toBe(true);
    expect(reading.overflowX).toBeLessThanOrEqual(1);
  }
  return layout;
}

for (const locale of LOCALES) {
  for (const theme of THEMES) {
    test(`Timeline entry and material controls fit ${locale} in ${theme}`, async ({ page }, testInfo) => {
      const errors = watchTimelineErrors(page);
      await openSmokeProject(page, 'A', 1);
      const projectId = smokeProjectId('A', 1);
      await expect(page.getByTestId('theme-toggle')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark)$/);
      const originalTheme = await page.evaluate(() => localStorage.getItem('breatic.theme'));
      if (originalTheme !== null && originalTheme !== 'light' && originalTheme !== 'dark' && originalTheme !== 'system') {
        throw new Error('the original browser theme is not an existing theme intent');
      }
      const originalResolvedTheme = await page.locator('html').getAttribute('data-theme');
      if (originalResolvedTheme !== 'light' && originalResolvedTheme !== 'dark') throw new Error('the original resolved theme is missing');
      let spaceId: string | null = null;
      try {
        spaceId = await createSpace(page, 'timeline', `Timeline entry ${locale} ${theme} ${crypto.randomUUID()}`);
        await switchLanguage(page, locale);
        await switchTheme(page, theme);
        const copy = timelineCopy(locale);
        const outlet = visibleSpace(page);
        const timeline = outlet.getByTestId('timeline-space');
        await expect(timeline).toHaveAttribute('data-project-id', projectId);
        await expect(timeline).toHaveAttribute('data-space-id', spaceId);
        await expect(timeline.getByTestId('timeline-space-empty')).toHaveText(copy.empty);
        await expect(timeline.getByText(copy.visualTrack, { exact: true })).toBeVisible();
        await expect(timeline.getByTestId('timeline-track-visual-1')).toBeVisible();
        await expect(timeline.getByTestId('timeline-play')).toHaveText(copy.play);
        await expect(timeline.getByTestId('timeline-play')).toBeDisabled();
        await expect(timeline.locator('[data-testid^="timeline-clip-"]')).toHaveCount(0);
        const addMedia = timeline.getByTestId('timeline-add-media');
        await expect(addMedia).toHaveText(copy.addMedia);
        await expect(addMedia).toBeEnabled();
        await page.evaluate(() => document.fonts.ready);
        const emptyLayout = await readLayout(timeline);
        expectViewportFit(emptyLayout);
        await timeline.screenshot({ path: testInfo.outputPath(`timeline-empty-${locale}-${theme}.png`) });

        const directoryRead = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return response.request().method() === 'GET'
            && url.pathname === `/api/v1/projects/${projectId}/assets`
            && url.searchParams.get('kind') === 'video';
        });
        await addMedia.focus();
        await expect(addMedia).toBeFocused();
        await addMedia.press('Enter');
        const dialog = page.getByRole('dialog', { name: copy.addMedia, exact: true });
        await expect(dialog).toBeVisible();
        const response = await directoryRead;
        expect(response.status(), 'read the actual authorized Project video directory').toBe(200);
        await response.finished();
        await expect(dialog.getByText(copy.material.loading, { exact: true })).toHaveCount(0);
        await expect(dialog.getByTestId('timeline-material-error')).toHaveCount(0);
        const projectMode = dialog.getByTestId('timeline-material-project');
        const localMode = dialog.getByTestId('timeline-material-local');
        await expect(projectMode).toHaveText(copy.material.project);
        await expect(projectMode).toBeEnabled();
        await expect(projectMode).toHaveAttribute('aria-pressed', 'true');
        await expect(localMode).toHaveText(copy.material.local);
        await expect(localMode).toBeEnabled();
        await expect(dialog.getByTestId('timeline-start-frame')).toHaveValue('0');
        await expect(dialog.getByLabel(copy.startFrame, { exact: true })).toBeVisible();
        await expect(dialog.getByTestId('timeline-confirm-material')).toHaveText(copy.material.confirm);
        await expect(dialog.getByRole('button', { name: copy.cancel, exact: true })).toBeVisible();
        const projectLayout = await expectDialogOperations(dialog);
        await dialog.screenshot({ path: testInfo.outputPath(`timeline-material-${locale}-${theme}.png`) });

        await localMode.focus();
        await localMode.press('Enter');
        await expect(localMode).toHaveAttribute('aria-pressed', 'true');
        await expect(projectMode).toHaveAttribute('aria-pressed', 'false');
        await expect(dialog.getByText(copy.material.fileEmpty, { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: copy.material.chooseFile, exact: true })).toBeEnabled();
        const localLayout = await expectDialogOperations(dialog);
        await projectMode.focus();
        await projectMode.press('Enter');
        await expect(projectMode).toHaveAttribute('aria-pressed', 'true');
        await expect(localMode).toHaveAttribute('aria-pressed', 'false');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(addMedia).toBeFocused();
        await expect(timeline.getByTestId('timeline-space-empty')).toHaveText(copy.empty);
        const layoutPath = testInfo.outputPath(`timeline-entry-layout-${locale}-${theme}.json`);
        writeFileSync(layoutPath, JSON.stringify({ locale, theme, emptyLayout, projectLayout, localLayout }, null, 2), 'utf8');
        await testInfo.attach('timeline-entry-layout', { path: layoutPath, contentType: 'application/json' });
        expect(errors.unexpected).toEqual([]);
      } finally {
        try {
          if (spaceId !== null) await deleteSpace(page, spaceId);
        } finally {
          try {
            await switchLanguage(page, 'en');
          } finally {
            await switchTheme(page, originalTheme ?? 'system');
            if (originalTheme === null) await page.evaluate(() => localStorage.removeItem('breatic.theme'));
            await expect(page.locator('html')).toHaveAttribute('data-theme', originalResolvedTheme);
          }
        }
      }
      expect(errors.unexpected).toEqual([]);
    });
  }
}
