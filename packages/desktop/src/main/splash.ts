// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The splash a build shows at launch (inner#2041, design §5.2): the brand's logo
 * and name, and on a partner's brand the "powered by" line. It is a local
 * page, so it shows before any server answers.
 */

import type { BuildBrand } from "@desktop/main/brand.js";

/** The shortest time the splash stays, so the attribution can be read. */
export const SPLASH_MIN_MS = 1_000;
/** The longest the splash stays: then the first window shows even while it is still loading (Mattermost's MAX_LOADING_SCREEN_SECONDS). */
export const SPLASH_MAX_MS = 4_000;

/**
 * How long to keep the splash before closing it.
 * @param shownAt - When it appeared, in milliseconds.
 * @param now - The time now, in milliseconds.
 * @returns The wait left, zero once it has shown long enough.
 */
export function splashCloseDelay(shownAt: number, now: number): number {
  return Math.max(0, SPLASH_MIN_MS - (now - shownAt));
}

/**
 * Wait until the splash may close: once it has appeared and shown the
 * minimum, or at the deadline when it has not appeared by then.
 * @param splash - The splash.
 * @param splash.shown - Resolves with the time it appeared.
 * @param splash.deadline - The time after which a splash that never appeared is given up.
 * @param clock - The time source.
 * @param clock.now - The time now, in milliseconds.
 * @param clock.sleep - Resolves after a wait.
 * @returns When the splash may close.
 */
export async function untilSplashMayClose(
  splash: { shown: Promise<number>; deadline: number },
  clock: { now(): number; sleep(ms: number): Promise<void> },
): Promise<void> {
  const shownAt = await Promise.race([splash.shown, clock.sleep(Math.max(0, splash.deadline - clock.now())).then(() => null)]);
  if (shownAt !== null) await clock.sleep(splashCloseDelay(shownAt, clock.now()));
}

/**
 * What the splash page is told in its address.
 * @param brand - The build's brand.
 * @param brand.productName - The name under the logo.
 * @param brand.poweredBy - Whether the attribution line shows.
 * @param brand.splashLogo - The logo's file name beside the page.
 * @returns The query.
 */
export function splashQuery(brand: Pick<BuildBrand, "productName" | "poweredBy" | "splashLogo">): Record<string, string> {
  return { product: brand.productName, poweredBy: brand.poweredBy ? "1" : "0", logo: brand.splashLogo };
}
