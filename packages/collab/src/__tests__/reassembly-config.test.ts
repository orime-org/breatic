// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reassembly limits in `config/collab.yaml` (inner#1585): the two keys,
 * their validation when the config loads, and the per-connection cap derived
 * from `max_document_bytes`. The YAML is read for real and edited in memory.
 */
import type * as FsModule from "node:fs";
import type * as ConfigModuleShape from "../config.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { COLLAB_FRAME_MAX_BYTES } from "@breatic/shared";

const REAL = readFileSync(resolve(import.meta.dirname, "../../../../config/collab.yaml"), "utf-8");

/**
 * Set one top-level key in the YAML text, appending it when absent.
 * @param text - YAML text.
 * @param key - Key name.
 * @param value - New value, or null to remove the key.
 * @returns The edited text.
 */
function setKey(text: string, key: string, value: number | null): string {
  const line = new RegExp(`^${key}\\s*:.*$`, "m");
  if (value === null) return text.replace(line, "");
  return line.test(text) ? text.replace(line, `${key}: ${value}`) : `${text}\n${key}: ${value}\n`;
}

type ConfigModule = typeof ConfigModuleShape;

/**
 * Load the config module against an edited YAML.
 * @param edit - Edits applied to the shipped YAML.
 * @returns The freshly imported module.
 */
async function withYaml(edit: (text: string) => string): Promise<ConfigModule> {
  vi.resetModules();
  vi.doMock("node:fs", async (orig) => ({
    ...(await orig<typeof FsModule>()),
    readFileSync: () => edit(REAL),
  }));
  try {
    return await import("../config.js");
  } finally {
    vi.doUnmock("node:fs");
  }
}

/**
 * Load the config with some keys set.
 * @param keys - Keys to set (null removes).
 * @returns The module, its config loaded once.
 */
async function load(keys: Record<string, number | null>): Promise<ConfigModule> {
  return withYaml((text) => Object.entries(keys).reduce((t, [k, v]) => setKey(t, k, v), text));
}

describe("reassembly config", () => {
  it("C01 defaults the budget to 64 MiB and the idle timeout to 30 s", async () => {
    const mod = await load({ reassembly_budget_bytes: null, reassembly_idle_timeout_ms: null });
    const cfg = mod.getCollabConfig() as unknown as Record<string, unknown>;
    expect(cfg.reassembly_budget_bytes).toBe(67_108_864);
    expect(cfg.reassembly_idle_timeout_ms).toBe(30_000);
  });

  it("C02 the shipped YAML declares both keys", async () => {
    expect(REAL).toMatch(/^reassembly_budget_bytes\s*:\s*67108864/m);
    expect(REAL).toMatch(/^reassembly_idle_timeout_ms\s*:\s*30000/m);
    vi.resetModules();
    const mod = await import("../config.js");
    const cfg = mod.getCollabConfig() as unknown as Record<string, unknown>;
    expect(cfg.reassembly_budget_bytes).toBe(67_108_864);
    expect(cfg.reassembly_idle_timeout_ms).toBe(30_000);
  });

  it.each([
    [21_102_591, false],
    [21_102_592, true],
    [67_108_864, true],
    [21_102_592.5, false],
  ])("C03 budget %d with the default document cap loads: %s", async (budget, ok) => {
    const mod = await load({ reassembly_budget_bytes: budget });
    if (ok) {
      expect(mod.getCollabConfig()).toMatchObject({ reassembly_budget_bytes: budget });
    } else {
      expect(() => mod.getCollabConfig()).toThrow(/reassembly_budget_bytes/);
    }
  });

  it("C04 with a document cap of 1 the budget floor is twice 128 KiB", async () => {
    const low = await load({ max_document_bytes: 1, reassembly_budget_bytes: 262_143 });
    expect(() => low.getCollabConfig()).toThrow(/reassembly_budget_bytes/);
    const ok = await load({ max_document_bytes: 1, reassembly_budget_bytes: 262_144 });
    expect(ok.getReassemblyLimits().maxMessageBytes).toBe(131_072);
  });

  it("C05 with no document cap the budget must exceed 128 KiB", async () => {
    const low = await load({ max_document_bytes: 0, reassembly_budget_bytes: 131_072 });
    expect(() => low.getCollabConfig()).toThrow(/reassembly_budget_bytes/);
    const ok = await load({ max_document_bytes: 0, reassembly_budget_bytes: 131_073 });
    expect(ok.getReassemblyLimits().maxMessageBytes).toBe(131_073);
  });

  it.each([
    [0, false],
    [-1, false],
    [1.5, false],
    [1, true],
    [2_147_483_647, true],
    [2_147_483_648, false],
  ])("C06 idle timeout %d loads: %s", async (ms, ok) => {
    const mod = await load({ reassembly_idle_timeout_ms: ms });
    if (ok) {
      expect(mod.getCollabConfig()).toMatchObject({ reassembly_idle_timeout_ms: ms });
    } else {
      expect(() => mod.getCollabConfig()).toThrow(/reassembly_idle_timeout_ms/);
    }
  });

  it.each([
    [0, 67_108_864, 67_108_864],
    [0, 131_073, 131_073],
    [1, 67_108_864, 131_072],
    [65_535, 67_108_864, 131_072],
    [65_536, 67_108_864, 131_072],
    [65_537, 67_108_864, 131_073],
    [10_485_760, 67_108_864, 10_551_296],
  ])("C07 document cap %d with budget %d gives a per-connection cap of %d", async (doc, budget, expected) => {
    const mod = await load({ max_document_bytes: doc, reassembly_budget_bytes: budget });
    expect(mod.getReassemblyLimits().maxMessageBytes).toBe(expected);
  });

  it("C08 getReassemblyLimits returns the shipped limits", async () => {
    vi.resetModules();
    const mod = await import("../config.js");
    expect(mod.getReassemblyLimits()).toEqual({
      frameMaxBytes: 131_072,
      maxMessageBytes: 10_551_296,
      budgetBytes: 67_108_864,
      idleTimeoutMs: 30_000,
    });
    expect(mod.getReassemblyLimits().frameMaxBytes).toBe(COLLAB_FRAME_MAX_BYTES);
  });
});
