// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three ways sending one confirmation can end (task #13).
 *
 * Only who wrote what is under test here; the mail backend and the outbox
 * repository are both stood in for. Three things are watched: a send that
 * cannot claim the row does not go out, the send's result lands on the row it
 * claimed, and **a write that fails is not reported as a send that failed**.
 *
 * That last one is what the third adversarial round found. The write used to
 * sit inside the guard, so a database that blinked walked into the catch and
 * branded a letter already in the buyer's inbox as `failed` — which puts the
 * resend button back in front of them, and a second letter goes out.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.fn();
vi.mock("@breatic/core", () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
}));

const claimSend = vi.fn();
const recordSend = vi.fn();
vi.mock("@server/modules/payment/purchase-mail.repo.js", () => ({
  claimSend: (...args: unknown[]) => claimSend(...args),
  recordSend: (...args: unknown[]) => recordSend(...args),
}));

const { sendPurchaseConfirmation } = await import(
  "@server/modules/payment/purchase-mail.js"
);

/** One send request; the addressing fields are not what this step decides. */
const INPUT = {
  paymentId: "9f1c7c2e-0000-4000-8000-000000000001",
  to: "buyer@example.test",
  subject: "Your credits",
  html: "<p>ok</p>",
  text: "ok",
  staleSendingBefore: new Date("2026-08-27T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  claimSend.mockResolvedValue(1);
  recordSend.mockResolvedValue(undefined);
});

describe("sending one purchase confirmation", () => {
  it("does not send when the row is already held by somebody else", async () => {
    claimSend.mockResolvedValue(null);

    expect(await sendPurchaseConfirmation(INPUT)).toBe(false);

    expect(sendMail).not.toHaveBeenCalled();
    expect(recordSend).not.toHaveBeenCalled();
  });

  it("records the send under the claim it holds", async () => {
    sendMail.mockResolvedValue({ status: "sent" });

    expect(await sendPurchaseConfirmation(INPUT)).toBe(true);

    // The first three arguments are the contract. Whether a fourth is passed
    // as `undefined` or left off is the same call.
    expect(recordSend.mock.calls[0]!.slice(0, 3)).toEqual([
      INPUT.paymentId,
      1,
      "sent",
    ]);
  });

  it("says skipped where the backend puts no letter on the wire", async () => {
    sendMail.mockResolvedValue({ status: "backend_console" });

    expect(await sendPurchaseConfirmation(INPUT)).toBe(false);

    expect(recordSend.mock.calls[0]!.slice(0, 3)).toEqual([
      INPUT.paymentId,
      1,
      "skipped",
    ]);
  });

  it("records failed, with the reason, when the send itself throws", async () => {
    sendMail.mockRejectedValue(new Error("smtp refused"));

    expect(await sendPurchaseConfirmation(INPUT)).toBe(false);

    expect(recordSend).toHaveBeenCalledWith(
      INPUT.paymentId,
      1,
      "failed",
      "smtp refused",
    );
  });

  it("never calls a delivered letter failed because the write did not land", async () => {
    sendMail.mockResolvedValue({ status: "sent" });
    recordSend.mockRejectedValue(new Error("connection reset"));

    await expect(sendPurchaseConfirmation(INPUT)).rejects.toThrow(
      "connection reset",
    );

    // Exactly one write, and it says `sent`. With the write inside the guard,
    // this same failure reaches the catch and a second write brands the row
    // `failed`.
    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(recordSend.mock.calls[0]![2]).toBe("sent");
  });
});
