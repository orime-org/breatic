// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { liveModuleUrl, YJS_MANAGER } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { seedImageNode } from '../helpers/tab-restore';

test.use({ viewport: { width: 1400, height: 900 } });

/** A structural view of the canonical Y.Map, without loading another Yjs copy. */
interface MapView {
  get: (key: string) => MapView | undefined;
  set: (key: string, value: unknown) => void;
}

/**
 * Update an existing node in the page's canonical document.
 * @throws {Error} When the seeded node is absent from that document.
 */
async function setRunning(page: Page, spaceId: string, running: number): Promise<void> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  await page.evaluate(async ({ at, pid, sid, count }) => {
    const manager = await import(/* @vite-ignore */ at) as {
      docName: { canvasSpace: (project: string, space: string) => string };
      getDoc: (name: string) => { getMap: (name: string) => MapView };
    };
    const nodes = manager.getDoc(manager.docName.canvasSpace(pid, sid)).getMap('nodesMap');
    const data = nodes.get('restore-camera-0-0')?.get('data');
    if (!data) throw new Error('The seeded image is absent from the canonical document');
    data.set('taskCounts', { running: count, done: 0, failed: 0, expired: 0 });
  }, { at: managerAt, pid: smokeProjectId(), sid: spaceId, count: running });
}

test('background node activity leads the tab in five languages and both themes', async ({ page }, testInfo) => {
  const made: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let localeAt: string | undefined;
  let canvas: string | undefined;
  try {
    await openSmokeProject(page);
    canvas = await createSpace(page, 'canvas', `Busy Space 工作 作品 작업 ${Date.now()}`);
    made.push(canvas);
    await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible();
    await seedImageNode(page, smokeProjectId(), canvas, { x: 0, y: 0 });
    await expect(visibleSpace(page).locator('.react-flow__node[data-id="restore-camera-0-0"]')).toBeVisible();
    const other = await createSpace(page, 'document', `Other Space ${Date.now()}`);
    made.push(other);
    const tab = page.getByTestId(`space-tab-${canvas}`);
    const otherTab = page.getByTestId(`space-tab-${other}`);
    const busy = page.getByTestId(`space-tab-busy-${canvas}`);
    await expect(busy).toHaveCount(0);
    await setRunning(page, canvas, 2);
    await expect(busy).toBeVisible();
    await expect(otherTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId(`space-tab-busy-${other}`)).toHaveCount(0);
    localeAt = await liveModuleUrl(page, 'i18n/locale-bootstrap.ts');
    for (const theme of ['light', 'dark'] as const) {
      for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
        await page.evaluate(async ({ at, nextLocale, nextTheme }) => {
          const i18n = await import(/* @vite-ignore */ at) as { changeLocale: (value: string) => void };
          i18n.changeLocale(nextLocale);
          document.documentElement.dataset.theme = nextTheme;
        }, { at: localeAt, nextLocale: locale, nextTheme: theme });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(busy).toBeVisible();
        const geometry = await busy.evaluate((mark) => {
          const style = getComputedStyle(mark);
          const owner = mark.closest('[role="tab"]');
          const icon = mark.nextElementSibling;
          const label = owner?.querySelector('[data-testid^="space-tab-name-"]');
          return {
            width: style.width, height: style.height, animation: style.animationName,
            leading: owner?.firstElementChild === mark,
            beforeIcon: icon !== null && mark.getBoundingClientRect().right <= icon.getBoundingClientRect().left,
            beforeName: label !== undefined && label !== null && mark.getBoundingClientRect().right <= label.getBoundingClientRect().left,
            tabWidth: owner?.getBoundingClientRect().width ?? 0,
          };
        });
        expect(geometry).toMatchObject({ width: '12px', height: '12px', animation: 'spin', leading: true, beforeIcon: true, beforeName: true });
        expect(geometry.tabWidth).toBeLessThanOrEqual(160);
        const screenshot = testInfo.outputPath(`space-tab-task-status-${theme}-${locale}.png`);
        await page.screenshot({ path: screenshot });
        await testInfo.attach(`${theme}-${locale}`, { path: screenshot, contentType: 'image/png' });
      }
    }
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await otherTab.click();
    await setRunning(page, canvas, 1);
    await expect(busy).toBeVisible();
    await setRunning(page, canvas, 0);
    await expect(busy).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if (localeAt) {
      await page.evaluate(async (at) => {
        const i18n = await import(/* @vite-ignore */ at) as { changeLocale: (locale: string) => void };
        i18n.changeLocale('en');
        document.documentElement.dataset.theme = 'light';
      }, localeAt);
    }
    for (const id of made.reverse()) await deleteSpace(page, id);
  }
});
