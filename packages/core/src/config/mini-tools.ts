// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Container mini-tool loader (inner#888 §8, §9).
 *
 * Reads `config/mini-tools.yaml`: which container class each operation runs
 * in, how long it may run, what the precheck holds the reader to, and the
 * published prices a run's seconds are charged at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CONTAINER_OPS, type ContainerOp } from "@breatic/shared/mini-tools";
import { MINI_TOOL_JOB_MAX_OUTPUTS, miniToolPlanLimitsSchema } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const classSchema = z.object({
  instance_type: z.string().min(1),
  vcpu: z.number().positive(),
  memory_gib: z.number().positive(),
  disk_gb: z.number().positive(),
});

const opSchema = z.strictObject({
  container_class: z.string().min(1),
  precheck_seconds: z.number().positive(),
});

// Initial ceilings reuse the existing per-job output contract and video cut precheck,
// not measured Std4 throughput; capacity qualification is still outstanding.
const executionDefaults = { container_class: "MiniToolContainerStd4" as const, precheck_seconds: 300, max_outputs: 8, max_outputs_per_job: 8 };
const containerExecutionSchema = z.strictObject({
  container_class: z.literal("MiniToolContainerStd4").default(executionDefaults.container_class),
  precheck_seconds: z.number().positive().default(executionDefaults.precheck_seconds),
  max_outputs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(executionDefaults.max_outputs),
  // Outputs one batch job writes (design §5.4); the job contract caps it.
  max_outputs_per_job: z.number().int().positive().max(MINI_TOOL_JOB_MAX_OUTPUTS).default(executionDefaults.max_outputs_per_job),
});

// Model input preparation for background removal encodes on standard-4 (design §5.3, §5.4).
const preparationDefaults = { container_class: "MiniToolContainerStd4" as const, precheck_seconds: 300 };
const removeBackgroundDefaults = { model: "bria-fibo-video-background-remover", preparation: preparationDefaults };
const removeBackgroundSchema = z.strictObject({
  model: z.string().min(1),
  preparation: z.strictObject({
    container_class: z.literal("MiniToolContainerStd4").default(preparationDefaults.container_class),
    precheck_seconds: z.number().positive().default(preparationDefaults.precheck_seconds),
  }).default(preparationDefaults),
});

// Chunked encoding (design §5.4): encode jobs run only on standard-4, so the encoder's rates are configured once, for it.
const encoderDefaults = {
  container_class: "MiniToolContainerStd4" as const,
  start_seconds: 3,
  encode_pixels_per_second: 163_000_000,
  decode_convert_pixels_per_second: { sdr_8bit: 1_950_000_000, sdr_10bit: 705_000_000, hdr_8bit: 152_000_000, hdr_10bit: 103_000_000 },
};
const pixelRate = z.number().positive().finite();
const encodingDefaults = { chunk_share: 0.5, max_parallel_chunks: 8, encoder: encoderDefaults };
const encodingSchema = z.strictObject({
  chunk_share: z.number().positive().max(1).default(encodingDefaults.chunk_share),
  max_parallel_chunks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(encodingDefaults.max_parallel_chunks),
  encoder: z.strictObject({
    container_class: z.literal("MiniToolContainerStd4").default(encoderDefaults.container_class),
    start_seconds: z.number().nonnegative().finite().default(encoderDefaults.start_seconds),
    encode_pixels_per_second: pixelRate.default(encoderDefaults.encode_pixels_per_second),
    decode_convert_pixels_per_second: z.strictObject({ sdr_8bit: pixelRate, sdr_10bit: pixelRate, hdr_8bit: pixelRate, hdr_10bit: pixelRate })
      .default(encoderDefaults.decode_convert_pixels_per_second),
  }).default(encoderDefaults),
  // Derived from the ledger byte caps, never configured: a value carried by an already parsed configuration is replaced.
  copy_disk_margin_bytes: z.number().optional(),
});

// The encoded presentation carrier (design §4.3, §8.2).
const carrierDefaults = { container_class: "MiniToolContainerStd4", max_short_side: 1080, color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } };
const colorTag = z.string().min(1);
const carrierSchema = z.strictObject({
  container_class: z.string().min(1).default(carrierDefaults.container_class),
  max_short_side: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(carrierDefaults.max_short_side),
  color: z.strictObject({ primaries: colorTag, transfer: colorTag, matrix: colorTag, range: colorTag }).default(carrierDefaults.color),
});

const analysisProfileSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  weightsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  params: z.record(z.string(), z.json()),
});

const analysisConfigSchema = z.strictObject({
  profile: analysisProfileSchema,
  container_class: z.string().min(1),
  precheck_seconds: z.number().positive(),
});

const sourceLedgerDefaults = {
  max_bytes: 16_777_216,
  probe_stdout_bytes: 67_108_864,
  metadata_bytes: 16_777_216,
  iso_box_count: 100_000,
  matroska_element_count: 1_000_000,
  matroska_max_blocks: 250_000,
};
const sourceLedgerConfigSchema = z.strictObject({
  max_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.max_bytes),
  probe_stdout_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.probe_stdout_bytes),
  metadata_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.metadata_bytes),
  iso_box_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.iso_box_count),
  matroska_element_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_element_count),
  matroska_max_blocks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_max_blocks),
});

/**
 * The disk a basic copy keeps free beyond twice the source (design §5.4): the full ledger and compact table caps added,
 * the only objects a copy writes besides the carrier; one `max_bytes` caps both today.
 * @param ledger - The source ledger byte caps.
 * @param ledger.max_bytes - The cap of each ledger object.
 * @returns The margin in bytes.
 * @throws {never} Never.
 */
function copyDiskMarginBytes(ledger: { max_bytes: number }): number {
  return ledger.max_bytes + ledger.max_bytes;
}

export const miniToolsConfigSchema = z
  .object({
    poll_interval_ms: z.number().int().positive(),
    executions: z.strictObject({
      "video.remove-bg": removeBackgroundSchema,
      "video.extract-frames": containerExecutionSchema.default(executionDefaults),
      "video.split": containerExecutionSchema.default(executionDefaults),
    }).default({ "video.remove-bg": removeBackgroundDefaults, "video.extract-frames": executionDefaults, "video.split": executionDefaults }),
    encoding: encodingSchema.default(encodingDefaults),
    presentation: z.strictObject({
      container_class: z.string().min(1).default("MediaContainer"),
      // Every uploadable video gets a presentation and a ledger: this equals storage.upload.max_upload_bytes.
      max_source_bytes: z.number().int().positive().default(2_147_483_648),
      max_packed_bytes: z.number().int().positive().default(1_073_741_824),
      crf: z.number().int().min(0).max(51).default(18),
      preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("medium"),
      source_ledger: sourceLedgerConfigSchema.default(sourceLedgerDefaults),
      carrier: carrierSchema.default(carrierDefaults),
    }).default({ container_class: "MediaContainer", max_source_bytes: 2_147_483_648, max_packed_bytes: 1_073_741_824, crf: 18, preset: "medium", source_ledger: sourceLedgerDefaults, carrier: carrierDefaults }),
    plan_limits: miniToolPlanLimitsSchema.extend({
      probeStdoutBytes: miniToolPlanLimitsSchema.shape.probeStdoutBytes.default(268_435_456),
      analysisStdoutBytes: miniToolPlanLimitsSchema.shape.analysisStdoutBytes.default(16_777_216),
      stderrTailBytes: miniToolPlanLimitsSchema.shape.stderrTailBytes.default(65_536),
    }).default({ probeStdoutBytes: 268_435_456, analysisStdoutBytes: 16_777_216, stderrTailBytes: 65_536 }),
    delivery: z.strictObject({
      discovery_interval_ms: z.number().int().positive().default(30_000),
      discovery_page_size: z.number().int().positive().default(100),
    }).default({ discovery_interval_ms: 30_000, discovery_page_size: 100 }),
    settlement: z.strictObject({
      lease_ms: z.number().int().positive().default(60_000),
      retry_ms: z.number().int().positive().default(30_000),
      lookup_timeout_ms: z.number().int().positive().default(15_000),
      discovery_interval_ms: z.number().int().positive().default(30_000),
      discovery_page_size: z.number().int().positive().default(100),
    }).default({ lease_ms: 60_000, retry_ms: 30_000, lookup_timeout_ms: 15_000, discovery_interval_ms: 30_000, discovery_page_size: 100 }),
    prices: z.object({
      vcpu_second_usd: z.number().nonnegative(),
      memory_gib_second_usd: z.number().nonnegative(),
      disk_gb_second_usd: z.number().nonnegative(),
    }),
    classes: z.record(z.string(), classSchema),
    ops: z.strictObject(
      Object.fromEntries(CONTAINER_OPS.map((op) => [op, opSchema])) as Record<ContainerOp, typeof opSchema>,
    ),
    analyses: z.strictObject({
      people: analysisConfigSchema,
      scene_cuts: analysisConfigSchema,
      tracked_mask: analysisConfigSchema,
    }),
    // The audio cut band draws from the peaks file beside the source; while that
    // file is missing it decodes the source in the browser only under both of
    // these: the length bounds what the tab holds, the size what it downloads.
    waveform_max_seconds: z.number().positive().default(600),
    waveform_max_bytes: z.number().int().positive().default(200_000_000),
    // How often, and for how long, a band past those reads peaks not yet written.
    waveform_peaks_retry_ms: z.number().int().positive().default(5000),
    waveform_peaks_retry_max_ms: z.number().int().positive().default(600_000),
  })
  .superRefine((config, ctx) => {
    if (!(config.presentation.container_class in config.classes)) {
      ctx.addIssue({ code: "custom", path: ["presentation", "container_class"], message: "Presentation names an undeclared container class" });
    }
    if (!(config.presentation.carrier.container_class in config.classes)) {
      ctx.addIssue({ code: "custom", path: ["presentation", "carrier", "container_class"], message: "The carrier names an undeclared container class" });
    }
    for (const [path, name] of [[["encoding", "encoder", "container_class"], config.encoding.encoder.container_class], [["executions", "video.remove-bg", "preparation", "container_class"], config.executions["video.remove-bg"].preparation.container_class]] as const) {
      if (!(name in config.classes)) ctx.addIssue({ code: "custom", path: [...path], message: "Names an undeclared container class" });
    }
    for (const tool of ["video.extract-frames", "video.split"] as const) {
      if (!(config.executions[tool].container_class in config.classes)) {
        ctx.addIssue({ code: "custom", path: ["executions", tool, "container_class"], message: "Execution names an undeclared container class" });
      }
    }
    for (const [op, spec] of Object.entries(config.ops)) {
      if (!(spec.container_class in config.classes)) {
        ctx.addIssue({
          code: "custom",
          path: ["ops", op, "container_class"],
          message: `names "${spec.container_class}", which classes does not declare`,
        });
      }
    }
    for (const [kind, spec] of Object.entries(config.analyses)) {
      if (!(spec.container_class in config.classes)) {
        ctx.addIssue({ code: "custom", path: ["analyses", kind, "container_class"], message: "Analysis names an undeclared container class" });
      }
    }
  })
  .transform((config) => ({ ...config, encoding: { ...config.encoding, copy_disk_margin_bytes: copyDiskMarginBytes(config.presentation.source_ledger) } }));

/** Validated container mini-tool configuration. */
export type MiniToolsConfig = z.infer<typeof miniToolsConfigSchema>;

let _cached: Readonly<MiniToolsConfig> | null = null;

/**
 * Load the container mini-tool configuration from YAML.
 * @returns Frozen, validated config, memoized after the first read.
 * @throws {z.ZodError} When a value is malformed or an op names an undeclared class.
 */
export function getMiniToolsConfig(): Readonly<MiniToolsConfig> {
  if (_cached) return _cached;

  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/mini-tools.yaml"), "utf-8");
  _cached = Object.freeze(miniToolsConfigSchema.parse(parse(raw) as unknown));
  return _cached;
}
