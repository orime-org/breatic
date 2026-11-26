// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * One function ends a timed-out Project transfer with its bell entry, wherever that happens (#1580, test spec C-17,
 * C-27): the deadline sweep and filing a new offer both call it, and it lives in domain beside the two repositories it
 * writes through, so server and worker share them.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as domain from "@domain/index.js";

const PACKAGES = path.join(import.meta.dirname, "..", "..", "..", "..");

/**
 * A source file under `packages/`.
 * @param file - Its path below `packages/`.
 * @returns Its text.
 */
function source(file: string): string {
  return readFileSync(path.join(PACKAGES, file), "utf8");
}

describe("ending a timed-out Project transfer", () => {
  it("C-17 is the same export for the sweep and for filing a new offer", () => {
    expect(source("domain/src/sweep/deadline-sweep.service.ts")).toMatch(/\bexpireDueTransfers\(/);
    expect(source("server/src/modules/project/projectTransfer.service.ts")).toMatch(/transferExpiryService\.expireDueTransfers\(/);
  });

  it("C-27 lives in domain with the notification and transfer repositories, which server no longer holds", () => {
    expect(Object.keys(domain)).toEqual(expect.arrayContaining(["notificationRepo", "projectTransfersRepo", "transferExpiryService"]));
    expect(existsSync(path.join(PACKAGES, "server/src/modules/notification/notification.repo.ts"))).toBe(false);
    expect(existsSync(path.join(PACKAGES, "server/src/modules/project/projectTransfers.repo.ts"))).toBe(false);
  });

  it("C-02 is run by the worker on its own queue, every configured interval, with failures logged", () => {
    const entry = source("worker/src/index.ts");
    expect(entry).toMatch(/createWorker<Record<string, never>>\(DEADLINE_SWEEP_QUEUE, \(\) => sweepDeadlines\(\)\)/);
    expect(entry).toMatch(/every: getWorkerConfig\(\)\.deadline_sweep\.interval_ms/);
    expect(entry).toMatch(/deadlineSweep\.on\("failed"[\s\S]{0,120}"deadline_sweep_failed"/);
  });
});
