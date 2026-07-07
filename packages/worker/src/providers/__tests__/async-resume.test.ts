// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from "vitest";

import { submitOrResume } from "@worker/providers/async-resume.js";

/**
 * #1628 (#1625 ⑦) — the async submit/resume core.
 *
 * When a job is retried by BullMQ after the vendor task was already created,
 * re-submitting would generate a SECOND (duplicate, billed) task. The guard:
 * persist the vendor task id right after submit; on retry, resume by polling
 * that id instead of re-submitting.
 */
describe("submitOrResume (#1628 ⑦ async resume)", () => {
  it("no stored id: submits, persists the returned id, then polls by it", async () => {
    const submit = vi.fn(async () => "vid-123");
    const persistId = vi.fn(async () => {});
    const poll = vi.fn(async (id: string) => ({ ok: true, id }));

    const r = await submitOrResume({ storedTaskId: null, submit, persistId, poll });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(persistId).toHaveBeenCalledWith("vid-123");
    expect(poll).toHaveBeenCalledWith("vid-123");
    expect(r).toEqual({ ok: true, id: "vid-123" });
  });

  it("INVARIANT: a stored id present → resume by polling, NEVER re-submit", async () => {
    const submit = vi.fn(async () => "should-not-be-called");
    const persistId = vi.fn(async () => {});
    const poll = vi.fn(async (id: string) => ({ ok: true, id }));

    const r = await submitOrResume({
      storedTaskId: "vid-existing",
      submit,
      persistId,
      poll,
    });

    expect(submit).toHaveBeenCalledTimes(0); // the ⑦ core invariant: no duplicate generation
    expect(persistId).toHaveBeenCalledTimes(0);
    expect(poll).toHaveBeenCalledWith("vid-existing");
    expect(r).toEqual({ ok: true, id: "vid-existing" });
  });

  it("submit failure propagates (BullMQ whole-job retry owns it); id not persisted, poll not reached", async () => {
    const submit = vi.fn(async () => {
      throw new Error("submit 5xx");
    });
    const persistId = vi.fn(async () => {});
    const poll = vi.fn();

    await expect(
      submitOrResume({ storedTaskId: null, submit, persistId, poll }),
    ).rejects.toThrow("submit 5xx");
    expect(persistId).toHaveBeenCalledTimes(0);
    expect(poll).toHaveBeenCalledTimes(0);
  });
});
