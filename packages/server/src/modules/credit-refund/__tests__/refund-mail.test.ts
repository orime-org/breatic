// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending one refund mail (inner#1410 §6.5 M1–M4, §8): who writes what.
 *
 * Contract this suite specifies (the implementation follows it exactly):
 *
 * `packages/server/src/modules/credit-refund/refund-mail.ts`
 *   - `sendRefundMail(mailId: string): Promise<boolean>` — claim the row
 *     (`refundMailRepo.claimSend`), load its view (`refundMailRepo.getMailView`),
 *     render it (`renderRefundMail`), `sendMail({ to, subject, html, text })`,
 *     then `refundMailRepo.recordSend(mailId, status, lastError?)`. Only the
 *     send is inside the try; the write-back is outside it, as in
 *     `purchase-mail.ts`. Returns whether the letter went out (`sent`).
 *     `sendMail` answering anything but `{ status: "sent" }` (console,
 *     disabled, smtp not configured) is `skipped`; a throw is `failed` with
 *     the error's message. A write-back that lands on nothing (`recordSend`
 *     answers false: the row was moved to `unknown` while the send was out)
 *     is discarded and leaves one log line through core's `logger` carrying
 *     `mailId`.
 *   - `sendDueRefundMails(): Promise<unknown>` — the loop's sweep (§7.1 step 3).
 *   - `markStaleRefundMailsUnknown(): Promise<unknown>` — M5, cutoff
 *     `now - getCreditRefundConfig().staleSendingMinutes`.
 *
 * `packages/server/src/modules/credit-refund/refund-mail.repo.ts` (added beside
 * `insertAuto`, `insertResend`, `findByKey`)
 *   - `claimSend(mailId: string): Promise<boolean>`
 *   - `recordSend(mailId: string, status: "sent" | "failed" | "skipped",
 *     lastError?: string): Promise<boolean>`
 *   - `markStaleUnknown(staleBefore: Date): Promise<number>`
 *   - `getMailView(mailId: string): Promise<RefundMailView | null>`
 *
 * `packages/server/src/modules/credit-refund/refund-mail-template.ts`
 *   - `RefundMailView`, `renderRefundMail(view): Promise<RenderedMail>`
 *     (see `refund-mail-template.integration.test.ts` for the view's shape).
 *
 * The mail backend, the repository and the template are stood in for here;
 * what the repository's conditions do against a real table is in
 * `refund-mail-outbox.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMail = vi.fn();
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock("@breatic/core", () => ({
  sendMail: (...args: unknown[]) => sendMail(...args),
  logger,
}));

const claimSend = vi.fn();
const recordSend = vi.fn();
const getMailView = vi.fn();
vi.mock("@server/modules/credit-refund/refund-mail.repo.js", () => ({
  claimSend: (...args: unknown[]) => claimSend(...args),
  recordSend: (...args: unknown[]) => recordSend(...args),
  getMailView: (...args: unknown[]) => getMailView(...args),
}));

const renderRefundMail = vi.fn();
vi.mock("@server/modules/credit-refund/refund-mail-template.js", () => ({
  renderRefundMail: (...args: unknown[]) => renderRefundMail(...args),
}));

vi.mock("@server/config/credit-refund.js", () => ({
  getCreditRefundConfig: () => ({ staleSendingMinutes: 10 }),
}));

const { sendRefundMail } = await import(
  "@server/modules/credit-refund/refund-mail.js"
);

const MAIL_ID = "5b0c7c2e-0000-4000-8000-000000000001";

/** What the repository hands the template; its fields are not decided here. */
const VIEW = {
  kind: "refund_rejected",
  email: "buyer@example.test",
  locale: "en",
  timeZone: "UTC",
  paymentId: "9f1c7c2e-0000-4000-8000-000000000001",
  credits: 880,
  purchasedAt: new Date("2026-09-01T01:30:00.000Z"),
  requestedAt: new Date("2026-09-03T02:45:00.000Z"),
};

/** The rendered letter. */
const LETTER = {
  to: "buyer@example.test",
  subject: "Your refund request",
  html: "<p>ok</p>",
  text: "ok",
};

beforeEach(() => {
  vi.clearAllMocks();
  claimSend.mockResolvedValue(true);
  recordSend.mockResolvedValue(true);
  getMailView.mockResolvedValue(VIEW);
  renderRefundMail.mockResolvedValue(LETTER);
});

describe("sending one refund mail", () => {
  it("does not send a row it could not claim", async () => {
    claimSend.mockResolvedValue(false);

    expect(await sendRefundMail(MAIL_ID)).toBe(false);

    expect(claimSend).toHaveBeenCalledWith(MAIL_ID);
    expect(sendMail).not.toHaveBeenCalled();
    expect(recordSend).not.toHaveBeenCalled();
  });

  it("sends the rendered letter to the buyer and records sent", async () => {
    sendMail.mockResolvedValue({ status: "sent" });

    expect(await sendRefundMail(MAIL_ID)).toBe(true);

    expect(getMailView).toHaveBeenCalledWith(MAIL_ID);
    expect(renderRefundMail).toHaveBeenCalledWith(VIEW);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      to: LETTER.to,
      subject: LETTER.subject,
      html: LETTER.html,
      text: LETTER.text,
    });
    // Whether a fourth argument is passed as `undefined` or left off is the
    // same call.
    expect(recordSend.mock.calls[0]!.slice(0, 2)).toEqual([MAIL_ID, "sent"]);
  });

  it("sends a refund_restored letter (v9 §8) the same way: rendered from its view, recorded sent", async () => {
    const restored = {
      kind: "refund_restored",
      email: "buyer@example.test",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
      paymentId: "9f1c7c2e-0000-4000-8000-000000000002",
      credits: 880,
      purchasedAt: new Date("2026-09-01T01:30:00.000Z"),
      requestedAt: new Date("2026-09-03T02:45:00.000Z"),
    };
    getMailView.mockResolvedValue(restored);
    sendMail.mockResolvedValue({ status: "sent" });

    expect(await sendRefundMail(MAIL_ID)).toBe(true);

    expect(renderRefundMail).toHaveBeenCalledWith(restored);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(recordSend.mock.calls[0]!.slice(0, 2)).toEqual([MAIL_ID, "sent"]);
  });

  it.each([
    ["the console backend", { status: "backend_console", to: "x", subject: "s", html: "h" }],
    ["the disabled backend", { status: "skipped", reason: "backend_disabled" }],
    ["smtp not configured", { status: "skipped", reason: "smtp_not_configured", to: "x", subject: "s" }],
  ])("records skipped for %s (M4)", async (_name, answer) => {
    sendMail.mockResolvedValue(answer);

    expect(await sendRefundMail(MAIL_ID)).toBe(false);

    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(recordSend.mock.calls[0]!.slice(0, 2)).toEqual([MAIL_ID, "skipped"]);
  });

  it("records failed, with the reason, when the send throws (M3)", async () => {
    sendMail.mockRejectedValue(new Error("smtp refused"));

    expect(await sendRefundMail(MAIL_ID)).toBe(false);

    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(recordSend).toHaveBeenCalledWith(MAIL_ID, "failed", "smtp refused");
  });

  it("never calls a delivered letter failed because the write-back did not land", async () => {
    sendMail.mockResolvedValue({ status: "sent" });
    recordSend.mockRejectedValue(new Error("connection reset"));

    await expect(sendRefundMail(MAIL_ID)).rejects.toThrow("connection reset");

    // One write, saying `sent`. With the write inside the guard the same
    // failure reaches the catch and a second write says `failed`.
    expect(recordSend).toHaveBeenCalledTimes(1);
    expect(recordSend.mock.calls[0]![1]).toBe("sent");
  });

  it("logs a late write-back that found the row no longer sending (M5 then M2)", async () => {
    /** Every log line written so far, whatever its level. */
    const lines = () => [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
    sendMail.mockResolvedValue({ status: "sent" });

    // What an ordinary send logs, so the extra line is measured against it.
    await sendRefundMail(MAIL_ID);
    const ordinary = lines().length;
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();

    recordSend.mockResolvedValue(false);
    await sendRefundMail(MAIL_ID);

    expect(lines()).toHaveLength(ordinary + 1);
    expect(lines().map((call) => call[0])).toContainEqual(expect.objectContaining({ mailId: MAIL_ID }));
  });
});
