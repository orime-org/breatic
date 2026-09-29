// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mail configuration (#286): the SMTP timeouts that keep one stuck send from
 * holding a connection for nodemailer's own defaults (two minutes to connect,
 * ten minutes idle), and the logo the branded layout shows.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, it, expect } from "vitest";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { mailConfigSchema } from "@core/config/mail.js";

const LOGO = "https://example.test/logo.png";

describe("mail config", () => {
  it("parses the shipped config/mail.yaml", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config/mail.yaml"), "utf-8"));
    expect(mailConfigSchema.parse(raw).smtp).toEqual({
      dns_timeout_ms: 5000,
      connection_timeout_ms: 5000,
      greeting_timeout_ms: 5000,
      socket_timeout_ms: 10000,
    });
  });

  it("falls back to the timeout defaults when the file names none", () => {
    expect(mailConfigSchema.parse({ layout: { logo_url: LOGO } }).smtp).toEqual({
      dns_timeout_ms: 5000,
      connection_timeout_ms: 5000,
      greeting_timeout_ms: 5000,
      socket_timeout_ms: 10000,
    });
  });

  it.each([0, -1, 1.5])("rejects a timeout of %s", (value) => {
    expect(() =>
      mailConfigSchema.parse({ smtp: { socket_timeout_ms: value }, layout: { logo_url: LOGO } }),
    ).toThrow();
  });

  it("reads the logo the layout shows from the shipped file", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config/mail.yaml"), "utf-8"));
    expect(mailConfigSchema.parse(raw).layout.logo_url).toMatch(/^https:\/\/.+\.png$/);
  });

  it("requires the logo address: a host is written down only in the yaml", () => {
    expect(() => mailConfigSchema.parse({})).toThrow();
  });

  it.each(["icon-192.png", "http://example.test/icon.png", "javascript:alert(1)"])(
    "rejects a logo address of %s",
    (value) => {
      expect(() => mailConfigSchema.parse({ layout: { logo_url: value } })).toThrow();
    },
  );
});
