// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Both AI SDK entry points route the SDK's warnings into our logger.
 *
 * The SDK writes warnings to `console` unless `globalThis.AI_SDK_LOG_WARNINGS`
 * is a function. Our logs are JSON on disk; anything going to console lands
 * nowhere anyone reads at 3am. Warnings are exactly the class of message that
 * matters then -- a provider quietly dropping a parameter, a model ignoring a
 * setting -- because the call still succeeds and nothing else says so.
 *
 * Asserting on the source rather than at runtime, because what has to hold is
 * that every entry point installs it. A runtime test would only cover
 * whichever one the test happened to boot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Entries that call the AI SDK. collab never does. */
const AI_SDK_ENTRIES = [
  "packages/server/src/index.ts",
  "packages/worker/src/index.ts",
] as const;

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/**
 * Read one entry point's source.
 * @param relativePath Repo-relative path to the entry.
 * @returns The file's contents.
 */
function entrySource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("AI SDK warning bridge", () => {
  it.each(AI_SDK_ENTRIES)("%s installs the bridge", (path) => {
    expect(entrySource(path)).toContain("AI_SDK_LOG_WARNINGS");
  });

  it.each(AI_SDK_ENTRIES)("%s installs it after initLogger", (path) => {
    // Installing first would capture a logger that is not configured yet.
    const source = entrySource(path);
    expect(source.indexOf("initLogger")).toBeLessThan(
      source.indexOf("AI_SDK_LOG_WARNINGS"),
    );
  });

  it.each(AI_SDK_ENTRIES)("%s does not switch warnings off", (path) => {
    // `= false` is the SDK's documented way to silence them entirely, which
    // is the one thing this must not be doing.
    expect(entrySource(path)).not.toMatch(/AI_SDK_LOG_WARNINGS\s*=\s*false/);
  });
});
