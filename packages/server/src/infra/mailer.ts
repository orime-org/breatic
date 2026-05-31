/**
 * Email sender — EMAIL_BACKEND 3-state dispatch.
 *
 * `env.EMAIL_BACKEND` routes `sendMail` to one of three backends:
 *
 *   disabled : no email sent, returns false silently. Self-host
 *              default — pair with recovery-code based password reset
 *              for SMTP-less installs.
 *   console  : email content logged to server log (dev: lift magic
 *              link / verify token straight out of stdout). Returns true.
 *   smtp     : dispatch via nodemailer using SMTP_* env. Returns true
 *              on success; returns false + warns if SMTP_HOST/USER
 *              not configured (legacy fallback preserved).
 *
 * Any SMTP-compatible service works under `smtp` (self-hosted postfix,
 * Resend, SendGrid, AWS SES, Gmail — all expose RFC 5321 SMTP).
 */

import nodemailer from "nodemailer";
import { env } from "@breatic/core";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!env.SMTP_HOST || !env.SMTP_USER) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASSWORD,
    },
  });

  return transporter;
}

export interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Discriminated result of {@link sendMail}. Per CLAUDE.md
 * "core 和 shared 不写任何日志" mandate, the library returns
 * status instead of logging — the application caller (server
 * route handler) decides what to log (e.g. info on `sent`,
 * warn on `smtp_not_configured`, dev-only console dump on
 * `backend_console`).
 */
export type SendMailResult =
  | { status: "sent" }
  | { status: "backend_console"; to: string; subject: string; html: string }
  | { status: "skipped"; reason: "backend_disabled" }
  | { status: "skipped"; reason: "smtp_not_configured"; to: string; subject: string };

/**
 * Send an email per `env.EMAIL_BACKEND` dispatch.
 *
 * @returns A {@link SendMailResult} describing what happened
 *   (sent / console-only / skipped). The application caller is
 *   responsible for logging audit / warning lines based on the
 *   status — see CLAUDE.md "core 和 shared 不写任何日志".
 */
export async function sendMail(options: SendMailOptions): Promise<SendMailResult> {
  if (env.EMAIL_BACKEND === "disabled") {
    return { status: "skipped", reason: "backend_disabled" };
  }

  if (env.EMAIL_BACKEND === "console") {
    return {
      status: "backend_console",
      to: options.to,
      subject: options.subject,
      html: options.html,
    };
  }

  // smtp path
  const t = getTransporter();
  if (!t) {
    return {
      status: "skipped",
      reason: "smtp_not_configured",
      to: options.to,
      subject: options.subject,
    };
  }

  await t.sendMail({
    from: env.SMTP_USER,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });

  return { status: "sent" };
}
