// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `config/credits.yaml`: how many credits a new account is granted with its
 * personal studio. Zero is a real value, and the figure the grant falls back
 * to when the section is left out.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { creditsConfigSchema, getTrialGrantCredits } from "@server/config/credits.js";

/**
 * A configuration directory holding one `credits.yaml`.
 * @param text - The file's content.
 * @returns The directory.
 */
function dirWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "credits-"));
  writeFileSync(join(dir, "credits.yaml"), text);
  return dir;
}

describe("credits config", () => {
  it("grants nothing when the section is left out", () => {
    expect(creditsConfigSchema.parse({}).trial_grant.credits).toBe(0);
  });

  it("refuses a negative grant", () => {
    expect(() => creditsConfigSchema.parse({ trial_grant: { credits: -1 } })).toThrow();
  });

  it("reads the grant from the deployment's file", () => {
    expect(getTrialGrantCredits(dirWith("trial_grant:\n  credits: 75\n"))).toBe(75);
  });

  it("grants nothing for a file that holds only comments", () => {
    expect(getTrialGrantCredits(dirWith("# the grant is off on this deployment\n"))).toBe(0);
  });

  it("fails loudly when the file is missing, naming the template and the old place", () => {
    expect(() => getTrialGrantCredits(mkdtempSync(join(tmpdir(), "credits-empty-")))).toThrow(
      /credits\.yaml\.template.*pricing\.yaml/s,
    );
  });
});
