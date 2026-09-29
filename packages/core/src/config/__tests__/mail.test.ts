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

const LAYOUT = {
  logo_url: "https://example.test/logo.png",
  site_url: "https://example.test",
  contact_email: "help@example.test",
  social: [{ label: "GitHub", url: "https://github.com/example" }],
};

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
    expect(mailConfigSchema.parse({ layout: LAYOUT }).smtp).toEqual({
      dns_timeout_ms: 5000,
      connection_timeout_ms: 5000,
      greeting_timeout_ms: 5000,
      socket_timeout_ms: 10000,
    });
  });

  it.each([0, -1, 1.5])("rejects a timeout of %s", (value) => {
    expect(() =>
      mailConfigSchema.parse({ smtp: { socket_timeout_ms: value }, layout: LAYOUT }),
    ).toThrow();
  });

  it("reads the layout from the shipped file", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config/mail.yaml"), "utf-8"));
    const { layout } = mailConfigSchema.parse(raw);
    expect(layout.logo_url).toMatch(/^https:\/\/.+\.png$/);
    expect(layout.site_url).toMatch(/^https:\/\/[^/]+$/);
    expect(layout.contact_email).toMatch(/^[^@\s]+@[^@\s]+$/);
    expect(layout.social.map((entry) => entry.label)).toEqual([
      "GitHub", "Discord", "X", "YouTube", "Instagram",
    ]);
  });

  it("requires the layout: a host is written down only in the yaml", () => {
    expect(() => mailConfigSchema.parse({})).toThrow();
  });

  it.each([
    ["logo_url", "icon-192.png"],
    ["logo_url", "http://example.test/icon.png"],
    ["logo_url", "javascript:alert(1)"],
    ["site_url", "http://example.test"],
    ["site_url", "https://example.test/"],
    ["contact_email", "not an address"],
  ])("rejects a %s of %s", (key, value) => {
    expect(() => mailConfigSchema.parse({ layout: { ...LAYOUT, [key]: value } })).toThrow();
  });

  it("rejects a social link that is not https", () => {
    expect(() =>
      mailConfigSchema.parse({
        layout: { ...LAYOUT, social: [{ label: "X", url: "http://x.example" }] },
      }),
    ).toThrow();
  });
});
