// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Studio page's one poll is paced by `config/studio-page.yaml` (#1580, test spec K-10): the server names the
 * interval in every answer, read through this loader, with 2000 ms when the key is absent.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { getStudioPageConfig, studioPageConfigSchema } from "@core/config/studio-page.js";

describe("the Studio page poll configuration", () => {
  it("K-10 reads poll_interval_ms from the tracked file", () => {
    const raw = parse(readFileSync(new URL("../../../../../config/studio-page.yaml", import.meta.url), "utf8")) as {
      poll_interval_ms: number;
    };
    expect(getStudioPageConfig().poll_interval_ms).toBe(raw.poll_interval_ms);
  });

  it("K-10 falls back to 2000 ms when the key is absent", () => {
    expect(studioPageConfigSchema.parse({}).poll_interval_ms).toBe(2000);
  });

  it("refuses an interval that is not a positive whole number of milliseconds", () => {
    for (const bad of [0, -1, 1.5, "2000"]) {
      expect(() => studioPageConfigSchema.parse({ poll_interval_ms: bad })).toThrow();
    }
  });
});
