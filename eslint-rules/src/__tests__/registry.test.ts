// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { breaticPlugin } from "#rules/index";

const RULES_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../rules",
);

describe("the rule registry", () => {
  it("exposes every rule that exists", () => {
    // A rule written and not exported is a file that reads like a guard,
    // tests like a guard, and never runs. Nothing else notices: the config
    // cannot switch on a rule the plugin does not offer, and eslint says
    // nothing about a rule nobody asked for.
    const onDisk = readdirSync(RULES_DIRECTORY)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();
    expect(Object.keys(breaticPlugin.rules).sort()).toEqual(onDisk);
  });

  it("names each rule the same as the file that defines it", () => {
    // The message a developer sees is the registered name; the file they
    // have to open is the one on disk. Letting the two drift turns every
    // violation into a search.
    const files = readdirSync(RULES_DIRECTORY);
    for (const name of Object.keys(breaticPlugin.rules)) {
      expect(files, name).toContain(`${name}.ts`);
    }
  });

  it("gives every rule a description and at least one message", () => {
    for (const [name, rule] of Object.entries(breaticPlugin.rules)) {
      expect(rule.meta?.docs?.description?.length, name).toBeGreaterThan(0);
      expect(
        Object.keys(rule.meta?.messages ?? {}).length,
        name,
      ).toBeGreaterThan(0);
    }
  });
});
