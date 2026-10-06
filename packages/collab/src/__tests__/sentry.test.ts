// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sentry = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn(async () => true),
  pinoIntegration: vi.fn((options: unknown) => ({ name: "Pino", options })),
  onUnhandledRejectionIntegration: vi.fn((options: unknown) => ({ name: "OnUnhandledRejection", options })),
}));
vi.mock("@sentry/node", () => sentry);

const config = vi.hoisted(() => ({ SENTRY_DSN: "", ENV: "prod" }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  env: config,
}));

import type * as CoreModule from "@breatic/core";
import { exitProcess, initSentry } from "@collab/sentry.js";

beforeEach(() => {
  vi.clearAllMocks();
  config.SENTRY_DSN = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initSentry", () => {
  it("does not start the SDK when no DSN is configured", () => {
    initSentry();
    expect(sentry.init).not.toHaveBeenCalled();
  });

  it("starts the SDK tagged as collab, forwarding error logs and leaving the exit on unhandled rejections to collab's own handler", () => {
    config.SENTRY_DSN = "https://key@o1.ingest.sentry.io/2";
    initSentry();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      dsn: "https://key@o1.ingest.sentry.io/2",
      environment: "production",
      initialScope: { tags: { service: "collab" } },
    });
    expect(sentry.pinoIntegration).toHaveBeenCalledWith({
      log: { levels: [] },
      error: { levels: ["error", "fatal"] },
    });
    expect(sentry.onUnhandledRejectionIntegration).toHaveBeenCalledWith({ mode: "none" });
  });
});

describe("exitProcess", () => {
  it("sends pending events before the process exits", async () => {
    const order: string[] = [];
    sentry.flush.mockImplementation(async () => {
      order.push("flush");
      return true;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      order.push("exit");
      throw new Error("process exited");
    }));

    await expect(exitProcess(1)).rejects.toThrow("process exited");

    expect(sentry.flush).toHaveBeenCalledWith(2000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(order).toEqual(["flush", "exit"]);
  });
});
