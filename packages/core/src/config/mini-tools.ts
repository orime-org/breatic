// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
  // Output pixels a GL image renders per second (frames-split §5.4 to-be-measured row); only the GL class declares it.
  render_pixels_per_second: z.number().positive().finite().optional(),
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
const preparationSchema = z.strictObject({
  container_class: z.literal("MiniToolContainerStd4").default(preparationDefaults.container_class),
  precheck_seconds: z.number().positive().default(preparationDefaults.precheck_seconds),
});
const removeBackgroundSchema = z.strictObject({
  model: z.string().min(1),
  preparation: preparationSchema.default(preparationDefaults),
});

// Lip-sync (execution design §9.3): the selectable single-person models, the tracking model's duration range and the run
// caps. No default: the models' contract values are measured per model, so a deployment without them offers no lip-sync.
const durationRange = { min_duration_seconds: z.number().positive(), max_duration_seconds: z.number().positive() };
const lipSyncSchema = containerExecutionSchema.extend({
  models: z.array(z.strictObject({
    name: z.string().min(1),
    schema_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    ...durationRange,
    crop_size: z.number().int().positive(),
    accepts_sync_mode: z.boolean(),
    async_rejection: z.strictObject({ path: z.string().min(1), equals: z.json() }).optional(),
  }).refine((model) => model.max_duration_seconds > model.min_duration_seconds)).min(1),
  tracking: z.strictObject({ model: z.string().min(1), ...durationRange }).refine((tracking) => tracking.max_duration_seconds > tracking.min_duration_seconds),
  max_people: z.number().int().positive(),
  max_dialogues: z.number().int().positive(),
  // The composite's feathered face edge, as a fraction of the face's shorter side (DD §7.2 step 6: feather(face) ∩ tracked
  // foreground); frozen into a run's plan at admission.
  face_feather: z.number().min(0).max(1).default(0.1),
});

// Chunked encoding (design §5.4): encode jobs run only on standard-4, so the encoder's rates are configured once, for it.
const encoderDefaults = {
  container_class: "MiniToolContainerStd4" as const,
  start_seconds: 3,
  // Local Docker readings at nproc 4 (encode-throughput nproc4 and 12-bit runs), to be replaced by Cloudflare standard-4 measurements.
  encode_pixels_per_second: 248_000_000,
  decode_convert_pixels_per_second: {
    sdr_8bit: 2_200_000_000, sdr_10bit: 1_310_000_000, sdr_12bit: 816_000_000, hdr_8bit: 106_000_000, hdr_10bit: 102_000_000, hdr_12bit: 109_000_000, sdr_16bit: 294_000_000, hdr_16bit: 71_900_000,
  },
  // Audio seconds encoded to AAC per second for the dispatched copy (local Docker nproc 4 reading, to be replaced by standard-4).
  aac_encode_seconds_per_second: 100,
  // Picture pixels per second YuNet 2023mar searches in the lip-sync faces step (frames-split §5.4 to-be-measured row), one detector
  // thread as the analysis runtime runs it: 120 1080p frames in 17.4–22.8 s on a maintainer machine held to standard-4
  // limits (arm64 Docker, --cpus=4), to be replaced by a Cloudflare standard-4 measurement.
  face_detect_pixels_per_second: 13_000_000,
};
const pixelRate = z.number().positive().finite();
const encodingDefaults = { chunk_share: 0.5, max_parallel_chunks: 8, chunk_retries: 3, reverse_buffer_bytes: 2_147_483_648, raw_disk_share: 0.5, encoder: encoderDefaults };
const encodingSchema = z.strictObject({
  chunk_share: z.number().positive().max(1).default(encodingDefaults.chunk_share),
  max_parallel_chunks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(encodingDefaults.max_parallel_chunks),
  // Retries after a chunk attempt fails; a chunk runs at most chunk_retries + 1 attempts (design §7.1.1).
  chunk_retries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(encodingDefaults.chunk_retries),
  // The decoded frames one job may hold to play a clip backwards; a longer reversed tracking clip is reversed in chunks
  // (execution design §10.2).
  reverse_buffer_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(encodingDefaults.reverse_buffer_bytes),
  // The share of a job's instance disk its raw decoded frames may fill, computed into a lip-sync plan once at admission: a
  // clip's reused crops and a composite chunk's raw source window stay within it (execution design paragraph before §9.4).
  raw_disk_share: z.number().positive().max(1).default(encodingDefaults.raw_disk_share),
  encoder: z.strictObject({
    container_class: z.literal("MiniToolContainerStd4").default(encoderDefaults.container_class),
    start_seconds: z.number().nonnegative().finite().default(encoderDefaults.start_seconds),
    encode_pixels_per_second: pixelRate.default(encoderDefaults.encode_pixels_per_second),
    decode_convert_pixels_per_second: z.strictObject({ sdr_8bit: pixelRate, sdr_10bit: pixelRate, sdr_12bit: pixelRate, hdr_8bit: pixelRate, hdr_10bit: pixelRate, hdr_12bit: pixelRate, sdr_16bit: pixelRate, hdr_16bit: pixelRate })
      .default(encoderDefaults.decode_convert_pixels_per_second),
    aac_encode_seconds_per_second: z.number().positive().finite().default(encoderDefaults.aac_encode_seconds_per_second),
    face_detect_pixels_per_second: pixelRate.default(encoderDefaults.face_detect_pixels_per_second),
  }).default(encoderDefaults),
  // Derived from the ledger byte caps, never configured: a value carried by an already parsed configuration is replaced.
  copy_disk_margin_bytes: z.number().optional(),
});

// The encoded presentation carrier (design §4.3, §8.2); it is encoded on encoding.encoder.container_class.
const carrierDefaults = { max_short_side: 1080, color: { primaries: "bt709", transfer: "bt709", matrix: "bt709", range: "tv" } };
const colorTag = z.string().min(1);
const carrierSchema = z.strictObject({
  max_short_side: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(carrierDefaults.max_short_side),
  color: z.strictObject({ primaries: colorTag, transfer: colorTag, matrix: colorTag, range: colorTag }).default(carrierDefaults.color),
});

// The identity qualification table (design §4.1): a source plays as itself only when its container, video codec,
// profile, pixel format, bit depth and audio are in this table, with no rotation, square samples and a tagged matrix.
// Only combinations official sources document as playable in desktop browsers belong here: MDN "Web video codec guide"
// and "Media container formats" (MP4 + H.264 Baseline/Main/High 8-bit 4:2:0, AAC or no audio). Changing the table
// changes the policy: raise presentation.policy_version with it.
const identityFormatSchema = z.strictObject({
  container: z.string().min(1),
  video_codec: z.string().min(1),
  profiles: z.array(z.string().min(1)).min(1),
  pix_fmt: z.string().min(1),
  bit_depth: z.number().int().positive().max(16),
  audio_codecs: z.array(z.string().min(1)).min(1),
  rotation: z.literal(0),
  sar: z.literal("1:1"),
  matrix_tagged: z.literal(true),
});
const identityFormatDefaults = [{
  container: "mp4", video_codec: "h264", profiles: ["Constrained Baseline", "Baseline", "Main", "High"], pix_fmt: "yuv420p", bit_depth: 8,
  audio_codecs: ["aac", "none"], rotation: 0 as const, sar: "1:1" as const, matrix_tagged: true as const,
}];
// One sampled frame classified alpha and colour of every measured fixture (inner#1306 test plan §91 D-6), so it is the default.
const probeSampleFramesDefault = 1;
// A single-frame source is shown this long (design §4.2.1).
const singleFrameDurationMsDefault = 5000;

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

// Erase (execution design §10.4, §10.6): the masked Bria eraser, its frame-for-frame grid ceiling, its measured duration
// bounds and asynchronous rejection field, and the composite matte in source pixels. No default, as lip-sync.
const eraseSchema = containerExecutionSchema.extend({
  model: z.strictObject({
    name: z.string().min(1), min_seconds: z.number().positive(), max_seconds: z.number().positive(), max_grid_fps: z.number().positive(),
    async_rejection: z.strictObject({ path: z.string().min(1), equals: z.json() }),
  }).refine((model) => model.max_seconds > model.min_seconds),
  matte: z.strictObject({ dilate: z.number().int().nonnegative(), feather: z.number().int().nonnegative() }),
});
// Expand (execution design §10.5, §10.6): VACE's window length, overlap and frame rate, and the source limits.
const expandSchema = containerExecutionSchema.extend({
  model: z.strictObject({ name: z.string().min(1), max_window_seconds: z.number().positive(), overlap_seconds: z.number().positive(), model_fps: z.number().int().positive() })
    .refine((model) => model.max_window_seconds > model.overlap_seconds),
  max_duration_seconds: z.number().positive(),
  max_target_side: z.number().int().positive(),
});

const sourceLedgerDefaults = {
  max_bytes: 16_777_216,
  probe_stdout_bytes: 67_108_864,
  metadata_bytes: 16_777_216,
  iso_box_count: 100_000,
  matroska_element_count: 1_000_000,
  matroska_max_blocks: 250_000,
  max_auto_repairs: 3,
};
const sourceLedgerConfigSchema = z.strictObject({
  max_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.max_bytes),
  probe_stdout_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.probe_stdout_bytes),
  metadata_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.metadata_bytes),
  iso_box_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.iso_box_count),
  matroska_element_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_element_count),
  matroska_max_blocks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_max_blocks),
  // Automatic ledger repairs after a transient ledger failure of a selected presentation (design §7.1).
  max_auto_repairs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.max_auto_repairs),
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
      "video.lip-sync": lipSyncSchema.optional(),
      "video.erase": eraseSchema.optional(),
      "video.expand": expandSchema.optional(),
      // Transitions encode on one class and render their overlap windows on the GL image's class (frames-split §5.4).
      "video.transitions": z.strictObject({ container_class: z.string().min(1), window_container_class: z.string().min(1), precheck_seconds: z.number().positive(),
        max_outputs: z.number().int().positive() }).optional(),
    }).default({ "video.remove-bg": removeBackgroundDefaults, "video.extract-frames": executionDefaults, "video.split": executionDefaults }),
    encoding: encodingSchema.default(encodingDefaults),
    presentation: z.strictObject({
      container_class: z.string().min(1).default("MediaContainer"),
      // The target presentation policy every admission and read freezes (design §3.2 item 1); a configured block names it.
      policy_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      probe_sample_frames: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(probeSampleFramesDefault),
      single_frame_duration_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(singleFrameDurationMsDefault),
      identity_formats: z.array(identityFormatSchema).default(identityFormatDefaults),
      // Every uploadable video gets a presentation and a ledger: this equals storage.upload.max_upload_bytes.
      max_source_bytes: z.number().int().positive().default(2_147_483_648),
      max_packed_bytes: z.number().int().positive().default(1_073_741_824),
      crf: z.number().int().min(0).max(51).default(18),
      preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("medium"),
      source_ledger: sourceLedgerConfigSchema.default(sourceLedgerDefaults),
      carrier: carrierSchema.default(carrierDefaults),
    }).default({ container_class: "MediaContainer", policy_version: 1, probe_sample_frames: probeSampleFramesDefault, single_frame_duration_ms: singleFrameDurationMsDefault,
      identity_formats: identityFormatDefaults, max_source_bytes: 2_147_483_648, max_packed_bytes: 1_073_741_824, crf: 18, preset: "medium", source_ledger: sourceLedgerDefaults, carrier: carrierDefaults }),
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
      // Tracking prepares its forward and reversed clips on standard-4 (execution design §10.3).
      tracked_mask: analysisConfigSchema.extend({ preparation: preparationSchema }),
    }),
    // The audio cut band draws from the peaks file beside the source; while that
    // file is missing it decodes the source in the browser only under both of
    // these: the length bounds what the tab holds, the size what it downloads.
    waveform_max_seconds: z.number().positive().default(600),
    waveform_max_bytes: z.number().int().positive().default(200_000_000),
    // How often, and for how long, a band past those reads peaks not yet written.
    waveform_peaks_retry_ms: z.number().int().positive().default(5000),
    waveform_peaks_retry_max_ms: z.number().int().positive().default(600_000),
    // How long a video tool panel's priced inputs hold still before it asks for a quote.
    quote_debounce_ms: z.number().int().nonnegative().default(300),
  })
  .superRefine((config, ctx) => {
    if (!(config.presentation.container_class in config.classes)) {
      ctx.addIssue({ code: "custom", path: ["presentation", "container_class"], message: "Presentation names an undeclared container class" });
    }
    for (const [path, name] of [[["encoding", "encoder", "container_class"], config.encoding.encoder.container_class], [["executions", "video.remove-bg", "preparation", "container_class"], config.executions["video.remove-bg"].preparation.container_class]] as const) {
      if (!(name in config.classes)) ctx.addIssue({ code: "custom", path: [...path], message: "Names an undeclared container class" });
    }
    const transitions = config.executions["video.transitions"];
    if (transitions !== undefined && !(transitions.window_container_class in config.classes)) {
      ctx.addIssue({ code: "custom", path: ["executions", "video.transitions", "window_container_class"], message: "Execution names an undeclared container class" });
    }
    for (const tool of ["video.extract-frames", "video.split", "video.lip-sync", "video.transitions", "video.erase", "video.expand"] as const) {
      const execution = config.executions[tool];
      if (execution !== undefined && !(execution.container_class in config.classes)) {
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
