// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 充值这条线的真机取数（任务 #13 视觉对抗）。
 *
 * 这里只放 jsdom 量不了的：计算样式、盒子几何、焦点环、对比度、明暗两套。
 * 哪些包列进「可以退的」、弹层勾选说什么、邮件里印什么，都由单测和集成测试
 * 逐条钉住，这里不重复。
 *
 * 需要 dev 起着 + smoke 账号：
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

/**
 * The session this file signs in for, once.
 *
 * Logging in is rate limited to five a minute, so a file where every test
 * signs in for itself starts failing at the fifth one — and the failure looks
 * like a navigation timeout rather than like a refusal.
 */
let session: Awaited<ReturnType<BrowserContext['cookies']>> = [];

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  if (!email || !password) return;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
  session = await context.cookies();
  await context.close();
});

/**
 * Put this file's one session on a fresh page.
 * @param page - The page.
 */
async function signIn(page: Page): Promise<void> {
  await page.context().addCookies(session);
}

/**
 * Open the credits overlay on one of its sections.
 * @param page - The page.
 * @param section - Which section to land on.
 */
async function openCredits(page: Page, section: string): Promise<void> {
  await page.goto('/studio');
  // The trigger is the header's account button; the avatar inside it carries
  // the testid but the button is what takes the click.
  await page.getByRole('button', { name: 'Account' }).click();
  const menu = page.locator('[data-testid="account-menu"]');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByRole('menuitem', { name: /credit|积分|點數/i }).click();
  await expect(page.locator('[data-testid="credits-index"]')).toBeVisible({
    timeout: 15_000,
  });
  if (section !== 'overview') {
    await page.locator(`#credits-tab-${section}`).click();
  }
  await expect(page.locator('[data-testid="credits-skeleton"]')).toHaveCount(0, {
    timeout: 15_000,
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`the confirm dialog holds its own in ${theme}`, async ({ page }) => {
    // Through the store's own persisted value rather than by stamping the
    // root: `openCredits` navigates, and a stamped attribute does not survive
    // that. The inline script in `index.html` reads this key before React
    // mounts, so every page in the run starts in the theme under test.
    await page.addInitScript((t) => {
      window.localStorage.setItem(
        'breatic.preferences',
        JSON.stringify({ state: { theme: t }, version: 1 }),
      );
    }, theme);
    await signIn(page);
    await openCredits(page, 'buy');
    await page
      .locator('[data-testid="credit-pack"]')
      .first()
      .getByRole('button')
      .click();
    await expect(page.locator('[data-testid="confirm-refund-ack"]')).toBeVisible({
      timeout: 10_000,
    });

    const measured = await page.evaluate(() => {
      // Contrast the way a person sees it: alpha composited against whatever
      // is behind, because the tokens that draw hairlines are `rgba(...)` and
      // a ratio taken off the raw value is not the one on the screen.
      const parse = (s: string): number[] => {
        const m = (s.match(/[\d.]+/g) ?? []).map(Number);
        return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
      };
      const luminance = (c: number[]): number => {
        const f = (v: number): number => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
      };
      const ratio = (fgText: string, bgText: string): number => {
        const bg = parse(bgText);
        const raw = parse(fgText);
        const a = raw[3]!;
        const fg = [0, 1, 2].map((i) => raw[i]! * a + bg[i]! * (1 - a));
        const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
        return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
      };
      // A control drawn on a transparent parent is seen against whatever is
      // further up, so that is what its border has to stand out from.
      const behind = (el: Element): string => {
        let node = el.parentElement;
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          if (c && c !== 'transparent' && !c.startsWith('rgba(0, 0, 0, 0)')) {
            return c;
          }
          node = node.parentElement;
        }
        return getComputedStyle(document.body).backgroundColor;
      };

      const tick = document.querySelector('[data-testid="confirm-refund-ack"]');
      const rule = document.querySelector('[data-testid="confirm-refund-rule"]');
      if (!tick || !rule) {
        throw new Error('the dialog is missing the tick or the rule');
      }
      const tickStyle = getComputedStyle(tick);
      const lines = [...rule.querySelectorAll('li')];
      const lineStyle = getComputedStyle(lines[0]!);

      return {
        // Asserted below. Without it the run reads exactly the same whether
        // the theme took or not, and one pass stands in for two.
        theme: document.documentElement.dataset.theme ?? 'unset',
        // The unchecked box: its border is the whole of what says it is
        // there, so that is what has to clear 3:1 (WCAG 1.4.11).
        tickBorder: tickStyle.borderTopColor,
        tickFill: tickStyle.backgroundColor,
        tickAgainstOwnFill: ratio(
          tickStyle.borderTopColor,
          tickStyle.backgroundColor,
        ),
        tickAgainstPanel: ratio(tickStyle.borderTopColor, behind(tick)),
        // The rule the tick refers to, now in the dialog rather than behind
        // its scrim. Body text, so 4.5:1 (WCAG 1.4.3).
        ruleLineCount: lines.length,
        ruleText: lines.map((li) => (li.textContent ?? '').slice(0, 60)),
        ruleContrast: ratio(lineStyle.color, behind(lines[0]!)),
        // Prose is not a two-sided list: no rule drawn between sentences.
        ruleSeparators: lines.filter(
          (li) => getComputedStyle(li).borderTopWidth !== '0px',
        ).length,
      };
    });

    // eslint-disable-next-line no-console
    console.log(`CONFIRM_DIALOG_${theme}`, JSON.stringify(measured, null, 2));

    expect(measured.theme).toBe(theme);
    expect(measured.tickAgainstOwnFill).toBeGreaterThanOrEqual(3);
    expect(measured.tickAgainstPanel).toBeGreaterThanOrEqual(3);
    expect(measured.ruleLineCount).toBe(3);
    expect(measured.ruleContrast).toBeGreaterThanOrEqual(4.5);
    expect(measured.ruleSeparators).toBe(0);
  });
}

test('the checkout wait can be left with a keyboard', async ({ page }) => {
  await signIn(page);
  // Hold the settle request open so the cover stays up long enough to be
  // measured. Without this it comes down the instant the answer lands.
  await page.route('**/payment/confirm**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await route.abort();
  });
  await page.goto('/studio?credits=1&session_id=cs_test_visual_probe');

  const cover = page.locator('[data-testid="checkout-wait"]');
  await expect(cover).toBeVisible({ timeout: 15_000 });

  // The trap this fixes: a modal holds the focus ring inside itself, so with
  // nothing focusable on the cover Tab had nowhere to go.
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-testid') ?? null,
  );
  expect(focused).toBe('checkout-wait-skip');

  const ring = await page
    .locator('[data-testid="checkout-wait-skip"]')
    .evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        outline: `${s.outlineStyle} ${s.outlineWidth}`,
        ringWidth: s.getPropertyValue('--tw-ring-offset-width'),
        boxShadow: s.boxShadow,
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
  // eslint-disable-next-line no-console
  console.log('CHECKOUT_WAIT_SKIP', JSON.stringify(ring, null, 2));

  await page.keyboard.press('Enter');
  // Pressing it lands where the timeout lands: the purchase history.
  await expect(page.locator('[data-testid="credits-index"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(cover).toHaveCount(0);
});

test('the buy screen and its confirm dialog measure up', async ({ page }) => {
  await signIn(page);
  await openCredits(page, 'buy');

  const panel = page.getByRole('tabpanel');
  const measured = await panel.evaluate((root) => {
    const rule = root.querySelector('[data-testid="buy-refund-rule"]');
    const pack = root.querySelector('[data-testid="credit-pack"]');
    const read = (el: Element | null): Record<string, string> | null => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        color: s.color,
        background: s.backgroundColor,
        fontSize: s.fontSize,
        borderRadius: s.borderRadius,
        borderWidth: s.borderTopWidth,
        width: String(Math.round(r.width)),
        height: String(Math.round(r.height)),
      };
    };
    return {
      refundRule: read(rule),
      pack: read(pack),
      refundLineCount: rule ? rule.querySelectorAll('li, [data-slot]').length : 0,
    };
  });

  // eslint-disable-next-line no-console
  console.log('BUY_SCREEN', JSON.stringify(measured, null, 2));
  expect(measured.pack).not.toBeNull();

  // The dialog: the tick, its label, and the button it gates.
  await page.locator('[data-testid="credit-pack"]').first().getByRole('button').click();
  const tick = page.locator('[data-testid="confirm-refund-ack"]');
  await expect(tick).toBeVisible({ timeout: 10_000 });

  // The overlay is a dialog too, so the confirm one is named.
  const confirm = page.getByRole('dialog', { name: /confirm/i });
  const dialog = await confirm.evaluate((root) => {
    const box = (el: Element | null): Record<string, number> | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    };
    const tickEl = root.querySelector('[data-testid="confirm-refund-ack"]');
    const label = tickEl?.closest('label') ?? null;
    const pay = root.querySelector('[data-testid="confirm-pay"]');
    const payStyle = pay ? getComputedStyle(pay) : null;
    return {
      dialog: box(root),
      tick: box(tickEl),
      label: box(label),
      labelText: label?.textContent ?? '',
      pay: box(pay),
      payDisabled: pay?.hasAttribute('disabled') ?? null,
      payOpacity: payStyle?.opacity ?? null,
      payCursor: payStyle?.cursor ?? null,
    };
  });

  // eslint-disable-next-line no-console
  console.log('CONFIRM_DIALOG', JSON.stringify(dialog, null, 2));

  // The tick gates the button; that much is behaviour the unit tests hold. What
  // is measured here is that the two are laid out as one row a pointer can hit.
  expect(dialog.payDisabled).toBe(true);
  expect(dialog.tick).not.toBeNull();
});

test('the refunds screen measures up', async ({ page }) => {
  await signIn(page);
  await openCredits(page, 'refunds');

  const panel = page.getByRole('tabpanel');
  const measured = await panel.evaluate((root) => {
    const read = (el: Element | null): Record<string, string> | null => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').slice(0, 120),
        color: s.color,
        fontSize: s.fontSize,
        width: String(Math.round(r.width)),
        height: String(Math.round(r.height)),
      };
    };
    const cards = [...root.querySelectorAll('[data-slot="card"], section, article')];
    const footnote = root.querySelector('footer, small, [data-slot="footnote"]');
    const refundBtn = [...root.querySelectorAll('button')].find((b) =>
      /refund|退款|退款/i.test(b.textContent ?? ''),
    );
    return {
      cardCount: cards.length,
      panelText: (root.textContent ?? '').slice(0, 400),
      footnote: read(footnote),
      refundButton: refundBtn
        ? {
          ...read(refundBtn),
          ariaDisabled: refundBtn.getAttribute('aria-disabled'),
          opacity: getComputedStyle(refundBtn).opacity,
        }
        : null,
    };
  });

  // eslint-disable-next-line no-console
  console.log('REFUNDS_SCREEN', JSON.stringify(measured, null, 2));
  expect(measured.panelText.length).toBeGreaterThan(0);
});
