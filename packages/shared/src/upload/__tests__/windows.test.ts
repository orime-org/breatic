// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one part may take, and why every window around it has to be wider.
 *
 * Both answers come from one piece of arithmetic: the browser sizes each
 * part's deadline with it, and the ticket endpoint checks the Durable Object's
 * idle window against it. Two copies would drift apart the first time either
 * side's figures moved.
 */

import { describe, it, expect } from "vitest";
import {
  partDeadlineMs,
  partRetryBudgetMs,
  completeRetryBudgetMs,
  answerRetentionMs,
  assertUploadWindows,
} from "@shared/upload/windows.js";
import {
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
} from "@shared/http/constants.js";

const CFG = { requestTimeoutMs: 30_000, minBytesPerSec: 65_536 };

describe("partDeadlineMs", () => {
  it("gives a small part the floor rather than a window it cannot use", () => {
    expect(partDeadlineMs(1024, CFG)).toBe(30_000);
  });

  it("scales with the bytes once they need longer than the floor", () => {
    // 8 MiB at 64 KiB/s is 128 seconds, well past the floor.
    expect(partDeadlineMs(8 * 1024 * 1024, CFG)).toBe(128_000);
  });
});

describe("partRetryBudgetMs", () => {
  it("counts every delivery the transport makes, not just the first", () => {
    const oneDelivery = partDeadlineMs(8 * 1024 * 1024, CFG);

    const budget = partRetryBudgetMs(8 * 1024 * 1024, CFG);

    expect(budget).toBeGreaterThan((MAX_RETRIES + 1) * oneDelivery);
  });

  // The waits between deliveries are the transport's own only when the server
  // named none. One that asks to be waited for is waited for, up to the bound
  // past which the transport stops instead — so that bound is what a budget
  // has to allow for, not the figure the transport would have picked.
  it("allows for the longest wait a server can ask for between them", () => {
    const deliveries = (MAX_RETRIES + 1) * partDeadlineMs(1024, CFG);

    expect(partRetryBudgetMs(1024, CFG)).toBe(
      deliveries + MAX_RETRIES * MAX_RETRY_AFTER_MS,
    );
  });

  // The shipped figures. An 8 MiB part can hold the browser for longer than
  // five minutes, which is what the Durable Object's idle window has to clear.
  it("exceeds five minutes for one part at the shipped part size", () => {
    expect(partRetryBudgetMs(8 * 1024 * 1024, CFG)).toBeGreaterThan(300_000);
  });
});

// Completing carries no bytes and names no deadline of its own, so each of its
// deliveries runs on the transport's default. The token it carries is the one
// the last part issued, and it has to outlast that whole chain — a token that
// expires partway turns the delivery that would have succeeded into a 401.
describe("completeRetryBudgetMs", () => {
  it("counts every delivery and the longest wait between them", () => {
    expect(completeRetryBudgetMs()).toBe(
      (MAX_RETRIES + 1) * DEFAULT_TIMEOUT_MS + MAX_RETRIES * MAX_RETRY_AFTER_MS,
    );
  });
});

describe("assertUploadWindows", () => {
  /** The shipped figures, with the pieces a case varies. */
  const windows = (over: Record<string, number> = {}): Parameters<
    typeof assertUploadWindows
  >[0] => ({
    partSizeBytes: 8 * 1024 * 1024,
    alarmIdleSeconds: 600,
    sessionTokenTtlSeconds: 1200,
    ticketExpiresSeconds: 300,
    requestTimeoutMs: 30_000,
    minBytesPerSec: 65_536,
    ...over,
  });

  it("accepts figures that leave every window wider than what it holds", () => {
    expect(() => assertUploadWindows(windows())).not.toThrow();
  });

  // One part's retries run to about 387 seconds, while an alarm at 300 judges
  // the upload dead: every part already written is dropped, and the browser is
  // still delivering.
  it("refuses an idle window a single part's retries can outlast", () => {
    expect(() => assertUploadWindows(windows({ alarmIdleSeconds: 300 }))).toThrow(
      /alarm_idle_seconds/,
    );
  });

  // The token is re-issued with every part, so it only has to cover the gap
  // between two of them — and the longest gap the alarm allows is its own
  // window.
  it("refuses a session token that expires inside the idle window", () => {
    expect(() =>
      assertUploadWindows(windows({ sessionTokenTtlSeconds: 600 })),
    ).toThrow(/session_token_ttl_seconds/);
  });

  // The last part issues the token that completing carries, so the token has
  // to outlast completing's own chain as well as the gap between parts.
  it("refuses a session token that expires inside the completion chain", () => {
    const short = Math.ceil(completeRetryBudgetMs() / 1000) - 1;

    expect(() =>
      assertUploadWindows(
        windows({ alarmIdleSeconds: 600, sessionTokenTtlSeconds: short }),
      ),
    ).toThrow(/session_token_ttl_seconds/);
  });

  // Letting go of a finished upload is also what stops the Durable Object
  // recognising the key as used. A ticket still valid then could open a second
  // multipart upload over an object the ledger already describes, leaving the
  // sha256 on that row describing bytes that are gone.
  it("refuses a ticket that outlives the memory of a finished upload", () => {
    const past = Math.ceil(answerRetentionMs(600) / 1000) + 1;

    expect(() =>
      assertUploadWindows(windows({ ticketExpiresSeconds: past })),
    ).toThrow(/ticket_expires_seconds/);
  });
});
