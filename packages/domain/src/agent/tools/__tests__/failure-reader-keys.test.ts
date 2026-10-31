// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's cause comes out of the same branch as the model's sentence
 * (inner#1620), so the two never tell different stories.
 */
import { describe, it, expect } from "vitest";
import { FAILURE_LINES } from "@breatic/shared";
import {
  notOurPayloadReason,
  readFailedReason,
  refusalReason,
  unreachableReason,
  type FailureVoice,
} from "@domain/agent/tools/failure.js";

const VOICE: FailureVoice = {
  act: "search",
  results: "search results",
  retrying: "Searching once more",
  elsewhere: "search again from another angle",
  attempting: "Searching for",
};

describe("a status the service refused with", () => {
  it.each([500, 503, 429, 408])("%i is their fault: busy, and the model stops", (status) => {
    const failure = refusalReason(VOICE, "q", status);
    expect(failure.readerKey).toBe(FAILURE_LINES.busy);
    expect(failure.forModel).toMatch(/Do not repeat this search/);
  });

  it.each([401, 403, 422, 404, 301])("%i is our configuration: unavailable, and the model stops", (status) => {
    const failure = refusalReason(VOICE, "q", status);
    expect(failure.readerKey).toBe(FAILURE_LINES.unavailable);
    expect(failure.forModel).toMatch(/Do not repeat this search/);
  });

  it("402 is our account with the service: unavailable, and the model stops rather than rewording", () => {
    const failure = refusalReason(VOICE, "q", 402);
    expect(failure.readerKey).toBe(FAILURE_LINES.unavailable);
    expect(failure.forModel).toMatch(/account/);
    expect(failure.forModel).toMatch(/Do not repeat this search/);
    expect(failure.forModel).not.toMatch(/different wording/);
  });

  it("any other 4xx is this request: refused, and the model may reword once", () => {
    const failure = refusalReason(VOICE, "q", 400);
    expect(failure.readerKey).toBe(FAILURE_LINES.refused);
    expect(failure.forModel).toMatch(/different wording at most once/);
  });

  it("a caller that knows the request is rewritable gets refused", () => {
    expect(refusalReason(VOICE, "q", 422, "", true).readerKey).toBe(FAILURE_LINES.refused);
  });

  it("a caller that knows the service named our configuration gets unavailable", () => {
    expect(refusalReason(VOICE, "q", 400, "", false).readerKey).toBe(FAILURE_LINES.unavailable);
  });
});

describe("the other ways a service fails", () => {
  it("an answer that is not results is badAnswer", () => {
    expect(notOurPayloadReason(VOICE, "q").readerKey).toBe(FAILURE_LINES.badAnswer);
  });

  it("an answer that stopped arriving is busy", () => {
    expect(readFailedReason(VOICE, "q", "socket hang up").readerKey).toBe(FAILURE_LINES.busy);
  });

  it("nothing answering is noConnection", () => {
    expect(unreachableReason(VOICE, "q", "ECONNREFUSED").readerKey).toBe(FAILURE_LINES.noConnection);
  });
});
