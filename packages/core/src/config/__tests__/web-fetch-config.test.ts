// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The figures `web_fetch` reads from configuration (inner#1664, design 6.5):
 * the seven `web_fetch_*` keys of `config/agent.yaml`, each also the schema
 * default so a deployment whose file predates them still runs, and the
 * container class the page reader is charged as in `config/mini-tools.yaml`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { agentConfigSchemaForTests } from "@core/config/loader.js";
import { getMiniToolsConfig } from "@core/config/mini-tools.js";

/** The seven figures, as design 6.5 sets them. */
const WEB_FETCH_FIGURES = {
  web_fetch_max_urls: 20,
  web_fetch_timeout_ms: 90_000,
  web_fetch_page_timeout_ms: 30_000,
  web_fetch_settle_ms: 8_000,
  web_fetch_concurrency: 6,
  web_fetch_max_chars: 80_000,
  web_fetch_max_bytes: 20_971_520,
};

/**
 * The shipped `config/agent.yaml`, parsed.
 * @returns Its top-level keys and values.
 */
function shippedAgentConfig(): Record<string, unknown> {
  const path = resolve(import.meta.dirname, "../../../../../config/agent.yaml");
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Only the `web_fetch_*` keys of a config.
 * @param config - Any agent config.
 * @returns Its web fetch figures.
 */
function webFetchFiguresOf(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith("web_fetch_")));
}

describe("web_fetch figures in config/agent.yaml", () => {
  it("are the seven figures of design 6.5 in the shipped file", () => {
    expect(webFetchFiguresOf(shippedAgentConfig())).toEqual(WEB_FETCH_FIGURES);
  });

  it("are the schema defaults too, so a file without them reads the same figures", () => {
    const parsed = agentConfigSchemaForTests.parse({}) as Record<string, unknown>;
    expect(webFetchFiguresOf(parsed)).toEqual(WEB_FETCH_FIGURES);
  });

  it("reach the loaded config as the shipped file states them", () => {
    const parsed = agentConfigSchemaForTests.parse(shippedAgentConfig()) as Record<string, unknown>;
    expect(webFetchFiguresOf(parsed)).toEqual(WEB_FETCH_FIGURES);
  });
});

describe("the page reader's container class in config/mini-tools.yaml", () => {
  it("is standard-2: one vCPU, 6 GiB of memory, 12 GB of disk", () => {
    expect(getMiniToolsConfig().classes.WebReaderContainer).toEqual({
      instance_type: "standard-2",
      vcpu: 1,
      memory_gib: 6,
      disk_gb: 12,
    });
  });
});
