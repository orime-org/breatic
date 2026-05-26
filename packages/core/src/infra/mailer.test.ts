/**
 * Mailer EMAIL_BACKEND 3-state contract — invariant test (PR-a task 4).
 *
 * Asserts that `env.EMAIL_BACKEND` routes `sendMail` to one of three paths:
 *
 *   disabled : no email sent, returns false silently
 *   console  : email content logged to logger.info, returns true
 *   smtp     : nodemailer dispatched, returns true; falls back to false +
 *              warn when SMTP_HOST/USER not configured (legacy preserved)
 *
 * Implementation lands in PR-a task 4 (amend mailer.ts to switch on
 * env.EMAIL_BACKEND). This test is RED until that change.
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
vi.mock("../config/env.js", () => ({
  get env() { return mockEnv; },
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock("../logger.js", () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, error: vi.fn() },
}));

describe("mailer — EMAIL_BACKEND 3-state contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Reset env to defaults each test
    mockEnv.EMAIL_BACKEND = "disabled";
    mockEnv.SMTP_HOST = "";
    mockEnv.SMTP_USER = "";
    mockEnv.SMTP_PASSWORD = "";
  });

  it("EMAIL_BACKEND=disabled — returns false, nodemailer never invoked", async () => {
    mockEnv.EMAIL_BACKEND = "disabled";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Verify your email",
      html: "<p>click <a href='https://x/verify?t=abc'>here</a></p>",
    });

    expect(result).toBe(false);
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("EMAIL_BACKEND=console — content logged to logger.info, returns true, nodemailer never invoked", async () => {
    mockEnv.EMAIL_BACKEND = "console";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Reset link",
      html: "<a href='https://x/reset?token=xyz'>reset</a>",
    });

    expect(result).toBe(true);
    expect(mockLoggerInfo).toHaveBeenCalled();
    const logCall = mockLoggerInfo.mock.calls[0];
    expect(logCall).toBeDefined();
    // Logger gets ({ to, subject, html } payload, message) — payload must contain to + subject
    const [payload] = logCall as [Record<string, unknown>, string];
    expect(payload.to).toBe("user@example.com");
    expect(payload.subject).toBe("Reset link");
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("EMAIL_BACKEND=smtp + SMTP_HOST/USER set — dispatches via nodemailer, returns true", async () => {
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

    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledOnce();
    const [opts] = mockSendMail.mock.calls[0] as [{ to: string; subject: string }];
    expect(opts.to).toBe("user@example.com");
    expect(opts.subject).toBe("Verify");
  });

  it("EMAIL_BACKEND=smtp but SMTP_HOST unset — warns + returns false (legacy fallback preserved)", async () => {
    mockEnv.EMAIL_BACKEND = "smtp";
    mockEnv.SMTP_HOST = "";

    const { sendMail } = await import("./mailer.js");
    const result = await sendMail({
      to: "user@example.com",
      subject: "Verify",
      html: "<p>v</p>",
    });

    expect(result).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});
