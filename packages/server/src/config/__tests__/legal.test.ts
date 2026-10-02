// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The terms version an account is created under (#302): the schema applies
 * its default and rejects an empty or over-long value, and the accessor
 * returns what `config/legal.yaml` ships.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import { legalConfigSchema, getLegalConfig } from "@server/config/legal.js";

describe("legal config - schema", () => {
  it("defaults to the terms published on 2026-10-02", () => {
    expect(legalConfigSchema.parse({})).toEqual({ terms_version: "2026-10-02" });
  });

  it("rejects an empty version and one too long for the column", () => {
    expect(() => legalConfigSchema.parse({ terms_version: "" })).toThrow();
    expect(() => legalConfigSchema.parse({ terms_version: "x".repeat(33) })).toThrow();
  });
});

describe("legal config - accessor reads config/legal.yaml", () => {
  it("returns the shipped version", () => {
    const shipped = parse(readFileSync(resolve(MONOREPO_ROOT, "config/legal.yaml"), "utf-8")) as {
      terms_version: string;
    };
    expect(getLegalConfig()).toEqual({ terms_version: shipped.terms_version });
  });
});
