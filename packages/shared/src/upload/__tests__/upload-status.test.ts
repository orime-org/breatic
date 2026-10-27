// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T38 (inner#1006 §4.4): a finished transfer upload has no asset, so the
 * status union gains `{ key, state: "transferred" }` while `completed` keeps
 * its required `result`. The assertions are on types and are checked by
 * `tsc --noEmit` (the package typecheck); the runtime lines only keep vitest
 * from treating the file as empty.
 */

import { describe, expect, it } from "vitest";

import type { UploadStatus } from "@shared/upload/upload-status.js";

describe("T38 UploadStatus", () => {
  it("has a transferred branch carrying only the key", () => {
    const transferred: UploadStatus = { key: "transfer/k.transfer", state: "transferred" };
    expect(transferred).toEqual({ key: "transfer/k.transfer", state: "transferred" });
  });

  it("still requires a result on completed", () => {
    // @ts-expect-error -- `completed` without `result` must stay a type error.
    const completed: UploadStatus = { key: "image/k.png", state: "completed" };
    expect(completed.state).toBe("completed");
  });
});
