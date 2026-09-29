// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mail configuration loader (#286).
 *
 * Reads `config/mail.yaml`: the SMTP timeouts `mailer.ts` hands to nodemailer,
 * and the addresses the branded layout links to. Lives in core because the mailer
 * does, and both server and collab send through it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const timeoutMs = z.number().int().positive();
const httpsUrl = z.url({ protocol: /^https$/ });

/**
 * The shape `config/mail.yaml` is parsed against. The SMTP section uses
 * `prefault({})` so an absent section still flows through the key defaults;
 * the layout has no defaults, because it names deployed hosts and the yaml is
 * the one place a host is written down.
 *
 * Exported for tests only; application code reads {@link getSmtpTimeouts} and
 * {@link getMailLayout}.
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
    logo_url: httpsUrl,
    site_url: httpsUrl.refine((url) => new URL(url).pathname === "/" && !url.endsWith("/"), {
      message: "site_url is an origin without a trailing slash",
    }),
    contact_email: z.email(),
    social: z.array(z.object({ label: z.string().min(1), url: httpsUrl })).min(1),
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

/** What the branded mail layout links to. */
export interface MailLayout {
  /** The logo at the top, an https PNG. */
  readonly logoUrl: string;
  /** The marketing site's origin, without a trailing slash. */
  readonly siteUrl: string;
  /** Where the help line sends people. */
  readonly contactEmail: string;
  /** The social row, in order. */
  readonly social: readonly { readonly label: string; readonly url: string }[];
}

/**
 * Reads what the branded mail layout links to.
 * @returns The logo, site, contact address and social links.
 * @throws {Error} When the file is missing or malformed.
 */
export function getMailLayout(): MailLayout {
  const { layout } = loadMailConfig();
  return {
    logoUrl: layout.logo_url,
    siteUrl: layout.site_url,
    contactEmail: layout.contact_email,
    social: layout.social,
  };
}
