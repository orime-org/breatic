// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mail configuration loader (#286).
 *
 * Reads `config/mail.yaml`: the SMTP timeouts `mailer.ts` hands to nodemailer,
 * and the logo the branded layout shows. Lives in core because the mailer
 * does, and both server and collab send through it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const timeoutMs = z.number().int().positive();

/**
 * The shape `config/mail.yaml` is parsed against. The SMTP section uses
 * `prefault({})` so an absent section still flows through the key defaults;
 * the logo address has no default, because it names a deployed host and the
 * yaml is the one place a host is written down.
 *
 * Exported for tests only; application code reads {@link getSmtpTimeouts} and
 * {@link getMailLogoUrl}.
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
  layout: z.object({
    logo_url: z.url({ protocol: /^https$/ }),
  }),
});

type MailConfig = z.infer<typeof mailConfigSchema>;

/** The SMTP timeouts, in milliseconds. */
export interface SmtpTimeouts {
  readonly dnsTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly greetingTimeoutMs: number;
  readonly socketTimeoutMs: number;
}

let cached: MailConfig | null = null;

/**
 * Reads and validates `config/mail.yaml` once.
 * @returns The parsed configuration.
 * @throws {Error} When the file is missing or malformed.
 */
function loadMailConfig(): MailConfig {
  if (cached) return cached;
  const configPath = resolve(MONOREPO_ROOT, "config/mail.yaml");
  cached = mailConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
  return cached;
}

/**
 * Reads the SMTP timeouts from `config/mail.yaml`.
 * @returns The four timeouts, in milliseconds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getSmtpTimeouts(): SmtpTimeouts {
  const { smtp } = loadMailConfig();
  return {
    dnsTimeoutMs: smtp.dns_timeout_ms,
    connectionTimeoutMs: smtp.connection_timeout_ms,
    greetingTimeoutMs: smtp.greeting_timeout_ms,
    socketTimeoutMs: smtp.socket_timeout_ms,
  };
}

/**
 * Reads the address of the logo the branded mail layout shows.
 * @returns An https URL of a PNG.
 * @throws {Error} When the file is missing or malformed.
 */
export function getMailLogoUrl(): string {
  return loadMailConfig().layout.logo_url;
}
