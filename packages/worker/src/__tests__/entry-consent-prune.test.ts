// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from "vitest";

/**
 * A stand-in for everything the worker entry touches: any property read or
 * call returns the same stand-in, so the entry runs end to end with nothing
 * real behind it. `then` stays undefined so awaiting it does not hang.
 */
const stub = vi.hoisted(() => {
  const target = function stubTarget(): void {};
  const proxy: unknown = new Proxy(target, {
    get: (_t, key) => (key === "then" ? undefined : key === Symbol.toPrimitive ? () => "stub" : proxy),
    apply: () => proxy,
    construct: () => proxy as object,
  });
  return proxy;
});

/**
 * A module whose named exports are the stand-in, apart from the ones given.
 * @param own - The exports a test watches.
 * @returns The module.
 */
const moduleOf = vi.hoisted(
  () =>
    (own: Record<string, unknown> = {}): Record<string, unknown> =>
      new Proxy(own, { get: (t, key) => (key in t ? t[key as string] : key === "then" ? undefined : stub), has: () => true }),
);

const core = vi.hoisted(() => ({
  createWorker: vi.fn((..._args: unknown[]) => stub),
  scheduleConsentPrune: vi.fn(async () => undefined),
}));

vi.mock("@worker/bootstrap-config.js", () => ({}));
vi.mock("@worker/sentry.js", () => moduleOf({ initSentry: () => "ok", exitProcess: async () => undefined }));
vi.mock("@breatic/core", () =>
  moduleOf({
    ...core,
    ANALYTICS_CONSENT_QUEUE: "analytics-consent",
    ADS_CONVERSION_QUEUE: "ads-conversion",
    // No vendor is configured on this deployment.
    adsConversionConfig: () => null,
    adsConversionState: () => "off",
    initServerAnalytics: () => "off",
    env: {},
  }),
);
vi.mock("@breatic/domain", () => moduleOf());
vi.mock("@worker/handlers/ads-conversion.js", () => moduleOf());
vi.mock("@worker/handlers/dispatch.js", () => moduleOf());
vi.mock("@worker/handlers/failed-job-cleanup.js", () => moduleOf());
vi.mock("@worker/handlers/url-ingest.js", () => moduleOf());
vi.mock("@worker/handlers/abort-ingest.js", () => moduleOf());
vi.mock("@worker/handlers/usage-lookup.js", () => moduleOf());
vi.mock("@worker/handlers/media-read.js", () => moduleOf());
vi.mock("@worker/handlers/upload-finish.js", () => moduleOf());
vi.mock("@worker/handlers/mail.js", () => moduleOf());

describe("consent receipt clean-up", () => {
  it("runs its worker and schedules the daily job on a deployment with no vendor configured", async () => {
    await import("@worker/index.js");
    expect(core.createWorker.mock.calls.some(([queue]) => queue === "analytics-consent")).toBe(true);
    expect(core.scheduleConsentPrune).toHaveBeenCalledTimes(1);
  });
});
