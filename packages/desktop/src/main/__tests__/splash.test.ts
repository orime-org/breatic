// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The splash a build shows at launch (inner#2041, design §5.2): the brand's logo
 * and name, and on a partner's brand the "powered by Breatic" line. It stays
 * at least a second so the attribution can be read, longer while the server
 * is still loading.
 */

import { describe, it, expect, vi } from "vitest";

import { SPLASH_MAX_MS, SPLASH_MIN_MS, splashCloseDelay, splashQuery, untilSplashMayClose } from "@desktop/main/splash.js";

describe("splashCloseDelay", () => {
  it("waits out the rest of the minimum when the server loads quickly", () => {
    expect(splashCloseDelay(1_000, 1_300)).toBe(SPLASH_MIN_MS - 300);
  });

  it("closes at once when the splash has shown long enough", () => {
    expect(splashCloseDelay(1_000, 1_000 + SPLASH_MIN_MS)).toBe(0);
    expect(splashCloseDelay(1_000, 9_000)).toBe(0);
  });

  it("stays at least a second and at most four", () => {
    expect(SPLASH_MIN_MS).toBeGreaterThanOrEqual(1_000);
    expect(SPLASH_MAX_MS).toBe(4_000);
  });
});

describe("splashQuery", () => {
  it("names a partner's product and asks for the attribution line", () => {
    expect(splashQuery({ productName: "Acme Studio", poweredBy: true, splashLogo: "logo.svg" })).toEqual({ product: "Acme Studio", poweredBy: "1", logo: "logo.svg" });
  });

  it("leaves the attribution off the official build", () => {
    expect(splashQuery({ productName: "Breatic", poweredBy: false, splashLogo: "logo.svg" }).poweredBy).toBe("0");
  });
});

describe("untilSplashMayClose", () => {
  /** Fake time, the splash's appearance and a flag that the wait is over. */
  function setup(): { appear(): void; done: () => boolean } {
    vi.useFakeTimers({ now: 0 });
    let appear = (): void => undefined;
    const shown = new Promise<number>((resolve) => {
      appear = () => resolve(Date.now());
    });
    let over = false;
    void untilSplashMayClose({ shown, deadline: SPLASH_MAX_MS }, { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }).then(() => {
      over = true;
    });
    return { appear, done: () => over };
  }

  it("waits for a splash that has not appeared yet, then keeps it the minimum", async () => {
    const { appear, done } = setup();
    await vi.advanceTimersByTimeAsync(200);
    expect(done()).toBe(false);
    appear();
    await vi.advanceTimersByTimeAsync(SPLASH_MIN_MS - 1);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
    vi.useRealTimers();
  });

  it("gives up on a splash that never appears at the longest time", async () => {
    const { done } = setup();
    await vi.advanceTimersByTimeAsync(SPLASH_MAX_MS - 1);
    expect(done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done()).toBe(true);
    vi.useRealTimers();
  });
});
