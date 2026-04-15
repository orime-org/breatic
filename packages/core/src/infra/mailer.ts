/**
 * SMTP email sender.
 *
 * Uses nodemailer to send transactional emails (password reset, etc.).
 * Configured via SMTP_* env vars. Fails silently in dev when SMTP
 * is not configured (logs warning instead of throwing).
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
 * Send an email. Returns true if sent, false if SMTP not configured.
 */
export async function sendMail(options: SendMailOptions): Promise<boolean> {
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
