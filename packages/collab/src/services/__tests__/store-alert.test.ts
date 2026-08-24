// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The alert is what turns a rescue file from a file nobody knows about into
 * something an operator acts on. Two things can silently defeat it: the mail
 * backend shipping disabled in both deployment templates, and a database
 * outage producing one mail per document per round.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ createLogger: () => mockLogger }));

import { createStoreAlerter } from "@collab/services/store-alert.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";
const OTHER = "project-11111111-1111-4111-8111-111111111111/document-2";

const FAILURE = {
  documentName: DOC,
  rescuePath: "/app/logs/rescue/inst-a__document-1__abc.yjs",
  bytes: 4096,
  reason: "database is down",
};

/**
 * Build an alerter with a controllable clock and a recording sender.
 * @param overrides - Recipient, window, and what the sender should return.
 * @returns The alerter, the sent mails, and a handle to move the clock.
 */
function harness(
  overrides: { to?: string; send?: () => Promise<unknown>; timeoutMs?: number } = {},
) {
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  let clock = 1_000_000;
  const alerter = createStoreAlerter({
    to: overrides.to ?? "ops@example.com",
    windowMs: 600_000,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    instanceId: "inst-a",
    now: () => clock,
    send: async (options) => {
      sent.push(options);
      if (overrides.send) return (await overrides.send()) as { status: "sent" };
      return { status: "sent" };
    },
  });
  return { alerter, sent, advance: (ms: number): void => void (clock += ms) };
}

beforeEach(() => vi.clearAllMocks());

describe("createStoreAlerter", () => {
  it("sends one mail carrying the instance and the rescue file path", async () => {
    const { alerter, sent } = harness();

    await alerter.alert(FAILURE);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("ops@example.com");
    expect(sent[0]?.html).toContain("inst-a");
    expect(sent[0]?.html).toContain(FAILURE.rescuePath);
    expect(sent[0]?.html).toContain(DOC);
  });

  it("does not send a second mail for the same document inside the window", async () => {
    const { alerter, sent } = harness();

    await alerter.alert(FAILURE);
    await alerter.alert(FAILURE);
    await alerter.alert(FAILURE);

    expect(sent).toHaveLength(1);
  });

  it("sends again once the window has passed", async () => {
    const { alerter, sent, advance } = harness();

    await alerter.alert(FAILURE);
    advance(600_001);
    await alerter.alert(FAILURE);

    expect(sent).toHaveLength(2);
  });

  it("keeps a separate window per document", async () => {
    const { alerter, sent } = harness();

    await alerter.alert(FAILURE);
    await alerter.alert({ ...FAILURE, documentName: OTHER });

    expect(sent).toHaveLength(2);
  });

  it("warns instead of sending when no recipient is configured", async () => {
    // Silence here would be the worst outcome: content was lost and nobody
    // is told, with nothing in the logs to say the alert never went out.
    const { alerter, sent } = harness({ to: "" });

    await alerter.alert(FAILURE);

    expect(sent).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0]?.[1]).toBe("collab_store_alert_undeliverable");
  });

  it("warns when the mail backend refuses to deliver", async () => {
    // EMAIL_BACKEND ships as `disabled` in both deployment templates, so
    // this is the default outcome, not an edge case.
    const { alerter } = harness({
      send: async () => ({ status: "skipped", reason: "backend_disabled" }),
    });

    await alerter.alert(FAILURE);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0]?.[1]).toBe("collab_store_alert_undeliverable");
  });

  it("logs and swallows a sender that throws", async () => {
    // The caller is the unload gate, inside a hook the library is waiting on;
    // a broken SMTP server must not become the reason a document cannot leave
    // memory.
    const { alerter } = harness({
      send: async () => {
        throw new Error("smtp unreachable");
      },
    });

    await expect(alerter.alert(FAILURE)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it("still opens the window when delivery failed, so a broken SMTP cannot flood", async () => {
    const { alerter, sent } = harness({
      send: async () => {
        throw new Error("smtp unreachable");
      },
    });

    await alerter.alert(FAILURE);
    await alerter.alert(FAILURE);

    expect(sent).toHaveLength(1);
  });
});

describe("an alert the mail server never answers", () => {
  // Gate 2 round 2 finding 4. This was the one step on the way out with no
  // deadline. nodemailer's transport is built without timeout options
  // (`core/src/infra/mailer.ts`), so it inherits a two-minute connection
  // timeout — and the gate awaits the alert inside `beforeUnloadDocument`.
  // An unreachable SMTP host during a database outage therefore held every
  // unloading document in memory for two minutes each, which is the failure
  // this whole design exists to prevent, arriving by a different door.

  it("gives up and says so rather than holding the caller", async () => {
    const { alerter } = harness({
      timeoutMs: 20,
      send: () => new Promise(() => {}),
    });

    await alerter.alert(FAILURE);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cause: "timed out" }),
      "collab_store_alert_undeliverable",
    );
  });

  it("does not wait for a transport that answers in time", async () => {
    const { alerter } = harness({ timeoutMs: 1_000 });

    await alerter.alert(FAILURE);

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});
