// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mail configuration (#286): the SMTP timeouts that keep one stuck send from
 * holding a connection for nodemailer's own defaults (two minutes to connect,
 * ten minutes idle).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, it, expect } from "vitest";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { mailConfigSchema } from "@core/config/mail.js";

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

  it("falls back to the key defaults when the file names nothing", () => {
    expect(mailConfigSchema.parse({}).smtp).toEqual({
      dns_timeout_ms: 5000,
      connection_timeout_ms: 5000,
      greeting_timeout_ms: 5000,
      socket_timeout_ms: 10000,
    });
  });

  it.each([0, -1, 1.5])("rejects a timeout of %s", (value) => {
    expect(() => mailConfigSchema.parse({ smtp: { socket_timeout_ms: value } })).toThrow();
  });
});
