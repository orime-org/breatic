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
import { env } from "../config/env.js";
import { logger } from "../logger.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!env.SMTP_HOST || !env.SMTP_USER) {
    logger.warn("SMTP not configured — emails will not be sent");
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
 * Send an email per `env.EMAIL_BACKEND` dispatch.
 *
 * @returns `true` if email was dispatched (smtp success) or logged
 *   (console), `false` if disabled or SMTP fallback to silent-skip
 *   (smtp mode but unconfigured).
 */
export async function sendMail(options: SendMailOptions): Promise<boolean> {
  if (env.EMAIL_BACKEND === "disabled") {
    return false;
  }

  if (env.EMAIL_BACKEND === "console") {
    logger.info(
      { to: options.to, subject: options.subject, html: options.html },
      "[console] email",
    );
    return true;
  }

  // smtp path
  const t = getTransporter();
  if (!t) {
    logger.warn({ to: options.to, subject: options.subject }, "Email not sent — SMTP not configured");
    return false;
  }

  await t.sendMail({
    from: env.SMTP_USER,
    to: options.to,
    subject: options.subject,
    html: options.html,
  });

  logger.info({ to: options.to, subject: options.subject }, "Email sent");
  return true;
}
