// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createAfterReply } from "@core/http/after-reply.js";

const onFailed = vi.fn();
const { runAfterReply, settleAfterReply, pendingAfterReply } = createAfterReply({ onFailed });

/**
 * A promise with its resolve and reject exposed.
 * @returns The promise and its two settlers.
 */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("after-reply work", () => {
  beforeEach(async () => {
    await settleAfterReply();
    vi.clearAllMocks();
  });

  it("returns before the work finishes and lists it until it does", async () => {
    const gate = deferred();
    runAfterReply({ task: "password_reset", userId: "u1" }, () => gate.promise);

    expect(pendingAfterReply()).toEqual([{ task: "password_reset", userId: "u1" }]);
    gate.resolve();
    await settleAfterReply();
    expect(pendingAfterReply()).toEqual([]);
  });

  it("settles only once every running piece of work has finished", async () => {
    const gate = deferred();
    let finished = false;
    runAfterReply({ task: "slow" }, async () => {
      await gate.promise;
      finished = true;
    });

    const settled = settleAfterReply().then(() => finished);
    gate.resolve();
    expect(await settled).toBe(true);
  });

  it("reports a failure with its context and drops it from the pending list", async () => {
    const gate = deferred();
    const err = new Error("smtp refused");
    runAfterReply({ task: "password_reset", email: "a@example.test" }, () => gate.promise);

    gate.reject(err);
    await settleAfterReply();

    expect(onFailed).toHaveBeenCalledWith(err, { task: "password_reset", email: "a@example.test" });
    expect(pendingAfterReply()).toEqual([]);
  });

  it("catches work that throws before its first await", async () => {
    const err = new Error("thrown synchronously");
    runAfterReply({ task: "sync" }, () => {
      throw err;
    });
    await settleAfterReply();
    expect(onFailed).toHaveBeenCalledWith(err, { task: "sync" });
  });
});
