// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { MONOREPO_ROOT } from "@core/config/env.js";
import { getMiniToolsConfig, miniToolsConfigSchema } from "@core/config/mini-tools.js";

// These are the independently selected operations defaults, not measured media capacity.
const DEFAULTS = {
  max_bytes: 16777216,
  probe_stdout_bytes: 67108864,
  metadata_bytes: 16777216,
  max_physical_frames: 100000,
  max_occurrences: 100000,
  iso_box_count: 100000,
  matroska_element_count: 1000000,
  matroska_max_blocks: 250000,
};
const CUSTOM = {
  max_bytes: 8388608,
  probe_stdout_bytes: 33554432,
  metadata_bytes: 2097152,
  max_physical_frames: 60000,
  max_occurrences: 70000,
  iso_box_count: 80000,
  matroska_element_count: 500000,
  matroska_max_blocks: 125000,
};
const FIELDS = ["max_bytes", "probe_stdout_bytes", "metadata_bytes", "max_physical_frames", "max_occurrences", "iso_box_count", "matroska_element_count", "matroska_max_blocks"] as const;
const INVALID = [
  { label: "zero", value: 0 },
  { label: "negative", value: -1 },
  { label: "fractional", value: 1.5 },
  { label: "infinity", value: Number.POSITIVE_INFINITY },
  { label: "NaN", value: Number.NaN },
  { label: "unsafe", value: 9007199254740992 },
];

/** Supplies one explicit ledger object through the existing loader schema. @throws {Error} When loading the repository configuration fails. */
function withLedger(sourceLedger: unknown): Record<string, unknown> {
  const config = structuredClone(getMiniToolsConfig());
  return { ...config, presentation: { ...config.presentation, source_ledger: sourceLedger } };
}

/** Observes the additive configuration field without implementing its future type. @throws {never} Never. */
function ledgerOf(config: { presentation: unknown }): unknown {
  return (config.presentation as Record<string, unknown>).source_ledger;
}

describe("source ledger operations configuration (inner#1306)", () => {
  it("records all eight selected defaults explicitly in the shipped YAML", () => {
    const raw = parse(readFileSync(resolve(MONOREPO_ROOT, "config/mini-tools.yaml"), "utf8")) as { presentation: Record<string, unknown> };
    expect(raw.presentation.source_ledger).toEqual(DEFAULTS);
  });

  it("loads the exact snake_case source ledger defaults through the existing getter", () => {
    expect(ledgerOf(getMiniToolsConfig())).toEqual(DEFAULTS);
  });

  it("defaults the whole presentation for an old configuration while preserving every existing sibling", () => {
    const { presentation: _omitted, ...legacy } = structuredClone(getMiniToolsConfig());
    expect(miniToolsConfigSchema.parse(legacy)).toEqual({
      ...legacy,
      presentation: {
        container_class: "MediaContainer", max_source_bytes: 2147483648, max_packed_bytes: 1073741824, crf: 18, preset: "medium",
        source_ledger: DEFAULTS,
      },
    });
  });

  it("defaults the new ledger in an old presentation without replacing its configured fields or plan limits", () => {
    const configured = getMiniToolsConfig();
    const presentation = { container_class: "MiniToolContainerStd1", max_source_bytes: 4096, max_packed_bytes: 8192, crf: 25, preset: "fast" };
    const plan_limits = { probeStdoutBytes: 65536, analysisStdoutBytes: 32768, stderrTailBytes: 1024 };
    const parsed = miniToolsConfigSchema.parse({ ...configured, presentation, plan_limits });
    expect(parsed.presentation).toEqual({ ...presentation, source_ledger: DEFAULTS });
    expect(parsed.plan_limits).toEqual(plan_limits);
    expect(parsed).toEqual({ ...configured, presentation: { ...presentation, source_ledger: DEFAULTS }, plan_limits });
  });

  it("defaults every omitted ledger field when the nested object is present but empty", () => {
    expect(ledgerOf(miniToolsConfigSchema.parse(withLedger({})))).toEqual(DEFAULTS);
  });

  it("preserves all explicit operations overrides instead of rejecting or replacing the nested object", () => {
    expect(ledgerOf(miniToolsConfigSchema.parse(withLedger(CUSTOM)))).toEqual(CUSTOM);
  });

  it.each([
    { field: "max_bytes", value: 8388608, expected: {
      max_bytes: 8388608, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "probe_stdout_bytes", value: 33554432, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 33554432, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "metadata_bytes", value: 2097152, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 2097152, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "max_physical_frames", value: 60000, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 60000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "max_occurrences", value: 70000, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 70000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "iso_box_count", value: 80000, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 80000, matroska_element_count: 1000000, matroska_max_blocks: 250000,
    } },
    { field: "matroska_element_count", value: 500000, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 500000, matroska_max_blocks: 250000,
    } },
    { field: "matroska_max_blocks", value: 125000, expected: {
      max_bytes: 16777216, probe_stdout_bytes: 67108864, metadata_bytes: 16777216, max_physical_frames: 100000,
      max_occurrences: 100000, iso_box_count: 100000, matroska_element_count: 1000000, matroska_max_blocks: 125000,
    } },
  ])("preserves a single $field override and defaults its seven omitted siblings", ({ field, value, expected }) => {
    expect(ledgerOf(miniToolsConfigSchema.parse(withLedger({ [field]: value })))).toEqual(expected);
  });

  it("accepts the positive integer lower boundary for every operations field", () => {
    const lower = { max_bytes: 1, probe_stdout_bytes: 1, metadata_bytes: 1, max_physical_frames: 1, max_occurrences: 1, iso_box_count: 1, matroska_element_count: 1, matroska_max_blocks: 1 };
    expect(ledgerOf(miniToolsConfigSchema.parse(withLedger(lower)))).toEqual(lower);
  });

  it("preserves the exact safe integer upper boundary without imposing an unapproved capacity ceiling", () => {
    const upper = {
      max_bytes: 9007199254740991, probe_stdout_bytes: 9007199254740991, metadata_bytes: 9007199254740991, max_physical_frames: 9007199254740991,
      max_occurrences: 9007199254740991, iso_box_count: 9007199254740991, matroska_element_count: 9007199254740991, matroska_max_blocks: 9007199254740991,
    };
    expect(ledgerOf(miniToolsConfigSchema.parse(withLedger(upper)))).toEqual(upper);
  });

  it.each(FIELDS.flatMap((field) => INVALID.map(({ label, value }) => ({ field, label, value }))))("rejects $label for $field", ({ field, value }) => {
    expect(miniToolsConfigSchema.safeParse(withLedger({ ...CUSTOM, [field]: value })).success).toBe(false);
  });
});
