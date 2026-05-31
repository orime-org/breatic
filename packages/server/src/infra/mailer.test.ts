/**
 * Mailer EMAIL_BACKEND 3-state contract — invariant test.
 *
 * Asserts that `env.EMAIL_BACKEND` routes `sendMail` to one of three paths
 * and returns the matching {@link SendMailResult} discriminant:
 *
 *   disabled : `{ status: 'skipped', reason: 'backend_disabled' }`
 *              + nodemailer never invoked
 *   console  : `{ status: 'backend_console', to, subject, html }`
 *              + nodemailer never invoked (application caller decides to
 *              dev-log the html dump)
 *   smtp     : `{ status: 'sent' }` when SMTP_HOST/USER set + nodemailer
 *              dispatched
 *   smtp (unconfigured): `{ status: 'skipped', reason: 'smtp_not_configured' }`
 *              + nodemailer never invoked (legacy fallback preserved as
 *              a result discriminant rather than a logger.warn line)
 *
 * Per CLAUDE.md "core 和 shared 不写任何日志" mandate (2026-05-27 PR
 * `feat/2026-05-27-collab-infra-resilience`), the library no longer
 * calls `logger.*` — the application caller logs based on the result.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendMail = vi.fn().mockResolvedValue({ messageId: "test-id" });
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mockSendMail })),
  },
}));

const mockEnv: Record<string, unknown> = {
  EMAIL_BACKEND: "disabled",
  SMTP_HOST: "",
  SMTP_PORT: 587,
  SMTP_USER: "",
  SMTP_PASSWORD: "",
};
// mailer reads `env` from the @breatic/core barrel (config is injected
// via initCore); the old `../config/env.js` module no longer exists, so
// mock the barrel's `env` export here.
vi.mock("@breatic/core", () => ({
  get env() { return mockEnv; },
}));

describe("mailer — EMAIL_BACKEND 3-state contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockEnv.EMAIL_BACKEND = "disabled";
    mockEnv.SMTP_HOST = "";
    mockEnv.SMTP_USER = "";
    mockEnv.SMTP_PASSWORD = "";
  });

  it("EMAIL_BACKEND=disabled — returns skipped/backend_disabled, nodemailer never invoked", async () => {
    mockEnv.EMAIL_BACKEND = "disabled";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Verify your email",
      html: "<p>click <a href='https://x/verify?t=abc'>here</a></p>",
    });

    expect(result).toEqual({ status: "skipped", reason: "backend_disabled" });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("EMAIL_BACKEND=console — returns backend_console with content, nodemailer never invoked", async () => {
    mockEnv.EMAIL_BACKEND = "console";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Reset link",
      html: "<a href='https://x/reset?token=xyz'>reset</a>",
    });

    expect(result).toEqual({
      status: "backend_console",
      to: "user@example.com",
      subject: "Reset link",
      html: "<a href='https://x/reset?token=xyz'>reset</a>",
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("EMAIL_BACKEND=smtp + SMTP_HOST/USER set — returns sent, nodemailer dispatched", async () => {
    mockEnv.EMAIL_BACKEND = "smtp";
    mockEnv.SMTP_HOST = "smtp.test.com";
    mockEnv.SMTP_USER = "smtp-user";
    mockEnv.SMTP_PASSWORD = "smtp-pass";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>v</p>",
    });

    expect(result).toEqual({ status: "sent" });
    expect(mockSendMail).toHaveBeenCalledOnce();
    const [opts] = mockSendMail.mock.calls[0] as [{ to: string; subject: string }];
    expect(opts.to).toBe("user@example.com");
    expect(opts.subject).toBe("Verify");
  });

  it("EMAIL_BACKEND=smtp but SMTP_HOST unset — returns skipped/smtp_not_configured (caller decides log)", async () => {
    mockEnv.EMAIL_BACKEND = "smtp";
    mockEnv.SMTP_HOST = "";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>v</p>",
    });

    expect(result).toEqual({
      status: "skipped",
      reason: "smtp_not_configured",
      to: "user@example.com",
      subject: "Verify",
    });
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
