// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The sentences the chat routes of inner#1717 answer a refusal with are
 * written in every language the product ships (SD-07b): the page shows the
 * server's sentence as it comes, so a missing one would reach the user as
 * the English fallback.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../locales");

/** The refusals these routes say in words of their own. */
const LINES = ["queue_full", "turn_busy", "shutting_down"] as const;

describe("the chat run refusals", () => {
  const files = readdirSync(LOCALES).filter((f) => f.endsWith(".json"));

  it("are read from all five catalogs", () => {
    expect(files.sort()).toEqual(["en.json", "ja.json", "ko.json", "zh-CN.json", "zh-TW.json"]);
  });

  for (const file of files) {
    it(`are each written in ${file} (SD-07b)`, () => {
      const catalog = JSON.parse(readFileSync(resolve(LOCALES, file), "utf-8")) as { server?: { chat?: Record<string, unknown> } };
      for (const line of LINES) {
        const said = catalog.server?.chat?.[line];
        expect(typeof said === "string" && said.trim() !== "", `${file} server.chat.${line}`).toBe(true);
      }
    });
  }
});
