// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * T29 (inner#1595): the error an upload the server could not open is thrown
 * as, and where it lives.
 *
 * The module holds that one class and the package entry hands out the very
 * same reference, because the server and the worker tell it apart with
 * `instanceof`. Settling a reader's link that did not land (`settleAborted`)
 * stays private to the backend lane: it throws an `AggregateError`, which is
 * not what an open failure carries.
 */

import { describe, expect, it } from "vitest";
import { INGEST_NO_ANSWER, UploadHttpError } from "@breatic/shared";

const domain = await import("@domain/index.js");
const mod = await import("@domain/asset/upload-open-failure.js");

describe("T29 UploadOpenFailed", () => {
  it("is the only thing its module holds, and the package entry exports the same class", () => {
    expect(Object.keys(mod)).toEqual(["UploadOpenFailed"]);
    expect(domain.UploadOpenFailed).toBe(mod.UploadOpenFailed);
    // The server calls the opener through this namespace.
    expect(typeof domain.uploadTicketService.openSignedUpload).toBe("function");
  });

  it("leaves settleAborted private to the backend lane", () => {
    expect("settleAborted" in domain).toBe(false);
    expect("settleAborted" in domain.uploadTicketService).toBe(false);
    expect("settleAborted" in domain.backendUploadService).toBe(false);
  });

  it("carries what settling decided when settling went through", () => {
    const settled = { status: "voided" as const, countsPublishFailed: true };
    const cause = new UploadHttpError(502, "store_failed");

    const failed = new mod.UploadOpenFailed({ storageKey: "k", reason: "store_failed", settled, cause });

    expect(failed).toBeInstanceOf(Error);
    expect(failed.storageKey).toBe("k");
    expect(failed.reason).toBe("store_failed");
    expect(failed.settled).toBe(settled);
    expect(failed.settleError).toBeUndefined();
    expect(failed.cause).toBe(cause);
  });

  it("carries the settling error itself, and no outcome, when settling failed too", () => {
    const settleError = new Error("db down");
    const cause = new TypeError("fetch failed");

    const failed = new mod.UploadOpenFailed({
      storageKey: "k",
      reason: INGEST_NO_ANSWER,
      settleError,
      cause,
    });

    expect(failed).toBeInstanceOf(Error);
    expect(failed.reason).toBe(INGEST_NO_ANSWER);
    expect(failed.settleError).toBe(settleError);
    expect(Object.hasOwn(failed, "settled")).toBe(false);
    expect(failed.cause).toBe(cause);
  });
});
