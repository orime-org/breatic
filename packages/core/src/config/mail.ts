// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mail configuration loader (#286).
 *
 * Reads `config/mail.yaml`: the SMTP timeouts `mailer.ts` hands to nodemailer.
 * Lives in core because the mailer does, and both server and collab send
 * through it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const timeoutMs = z.number().int().positive();

/**
 * The shape `config/mail.yaml` is parsed against. The section uses
 * `prefault({})` so an absent section still flows through the key defaults.
 *
 * Exported for tests only; application code reads {@link getSmtpTimeouts}.
 */
export const mailConfigSchema = z.object({
  smtp: z
    .object({
      dns_timeout_ms: timeoutMs.default(5000),
      connection_timeout_ms: timeoutMs.default(5000),
      greeting_timeout_ms: timeoutMs.default(5000),
      socket_timeout_ms: timeoutMs.default(10000),
    })
    .prefault({}),
});

/** The SMTP timeouts, in milliseconds. */
export interface SmtpTimeouts {
  readonly dnsTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly greetingTimeoutMs: number;
  readonly socketTimeoutMs: number;
}

let cached: SmtpTimeouts | null = null;

/**
 * Reads the SMTP timeouts from `config/mail.yaml`.
 * @returns The four timeouts, in milliseconds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getSmtpTimeouts(): SmtpTimeouts {
  if (cached) return cached;
  const configPath = resolve(MONOREPO_ROOT, "config/mail.yaml");
  const { smtp } = mailConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
  cached = {
    dnsTimeoutMs: smtp.dns_timeout_ms,
    connectionTimeoutMs: smtp.connection_timeout_ms,
    greetingTimeoutMs: smtp.greeting_timeout_ms,
    socketTimeoutMs: smtp.socket_timeout_ms,
  };
  return cached;
}
