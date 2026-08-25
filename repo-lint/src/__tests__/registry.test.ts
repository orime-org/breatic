// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKS } from "#repo-lint/checks/index";

const CHECKS_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../checks",
);

describe("the check registry", () => {
  it("runs every check that exists", () => {
    // A check written and not registered is a file that reads like a
    // guard, tests like a guard, and never runs — the same silence as no
    // guard at all, with the paperwork of having one. Nothing else would
    // notice: the suite would report one fewer check passing, and one
    // number in a summary is not something anybody diffs.
    const onDisk = readdirSync(CHECKS_DIRECTORY)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();
    const registered = CHECKS.map((check) => check.name).sort();
    expect(registered).toEqual(onDisk);
  });

  it("gives every check a distinct name", () => {
    // Two CHECKS under one name is one check reported twice and one
    // reported never; the run still says everything passed.
    const names = CHECKS.map((check) => check.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every check a description", () => {
    for (const check of CHECKS) {
      expect(check.description.length, check.name).toBeGreaterThan(0);
    }
  });
});
