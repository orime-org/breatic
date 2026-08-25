// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Nothing hands a picture to the model that answers chat.
 *
 * Recognising an image, a video or a recording belongs to a skill built for
 * it -- `config/models/understand/` is that set, and its files say so:
 * gemini declares image, video and audio modes, whisper declares transcribe,
 * and the header comment describes the guide text as something injected into
 * a skill prompt to help it pick a model.
 *
 * The path this file guards against was never walked. `buildUserContent`
 * assembled image parts out of resource URLs by file extension, the two chat
 * routes passed `body.resource_list` into it, and the one place the frontend
 * sends from has always written `resource_list: []`. The model this build
 * moves to takes text only, so the dead path would not survive the move
 * anyway.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Where the workspace packages live, from this file. */
const PACKAGES = resolve(import.meta.dirname, "../../../../");

/** Packages whose source is scanned. */
const SCANNED = ["shared", "core", "domain", "server", "worker", "collab", "web"];

/**
 * Every first-party source file, excluding tests.
 *
 * Tests are left out on purpose: this file names the string it is looking
 * for, so a scan that included tests would find itself. The parameter is
 * gone from production code or it is not, and that is what the acceptance
 * item says.
 * @returns Absolute paths.
 */
function productionSources(): string[] {
  const found: string[] = [];
  for (const pkg of SCANNED) {
    const root = resolve(PACKAGES, pkg, "src");
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true, encoding: "utf8" });
    } catch {
      // A package without a `src` is not a failure of this test to report.
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (entry.includes("__tests__")) continue;
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      found.push(resolve(root, entry));
    }
  }
  return found;
}

/**
 * Which of those files contain a string.
 * @param needle - What to look for.
 * @returns Paths relative to the packages directory, so a failure reads.
 */
function filesContaining(needle: string): string[] {
  return productionSources()
    .filter((path) => readFileSync(path, "utf8").includes(needle))
    .map((path) => path.slice(PACKAGES.length + 1));
}

describe("the resource list that fed pictures to the model", () => {
  it("is gone from every package", () => {
    // Five places held it: the two request schemas in shared, the two chat
    // routes, and the one frontend call that always sent an empty array.
    expect(filesContaining("resource_list")).toEqual([]);
  });
});

describe("the turn's user message", () => {
  it("is assembled without a branch for images", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../agent/main-agent.ts"),
      "utf8",
    );
    // `buildUserContent` existed to turn a list of URLs into image parts. A
    // turn's message is the text the reader typed; there is no second thing
    // to assemble it with.
    expect(source).not.toContain("buildUserContent");
    expect(source).not.toContain("ImagePart");
  });
});
