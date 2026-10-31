// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

const streamIndex = z.number().int().nonnegative();
const timestamp = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const range = z.object({ startUs: timestamp, endUs: timestamp }).strict()
  .refine((value) => BigInt(value.startUs) < BigInt(value.endUs), "Invalid source time range");

/** The kind of one complete media file sent to the understanding API. */
export const MediaInputDescriptorSchema = z.object({
  inputKind: z.literal("source_file"),
  mediaKind: z.enum(["audio", "video"]),
}).strict();

/** One probe-derived file and its complete source-time range. */
export const LongMediaInputSchema = z.object({
  mediaInputId: z.string().min(1),
  descriptor: MediaInputDescriptorSchema,
  sourceRange: range,
}).strict();

/** One measured stream contributing to the source file's time envelope. */
export const LongMediaStreamSchema = z.object({
  index: streamIndex,
  kind: z.enum(["audio", "video"]),
  startUs: timestamp,
  endUs: timestamp,
}).strict().refine((value) => BigInt(value.startUs) < BigInt(value.endUs), "Invalid stream time range");

/** Probe facts for one complete source file and its shared time axis. */
export const LongMediaProbeReportSchema = z.object({
  version: z.literal(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  selectedVideoStreamIndex: streamIndex.nullable(),
  streams: z.array(LongMediaStreamSchema).min(1),
  mediaInputs: z.array(LongMediaInputSchema).length(1),
}).strict().superRefine((report, context) => {
  const streamsByIndex = new Map(report.streams.map((stream) => [stream.index, stream]));
  if (streamsByIndex.size !== report.streams.length) {
    context.addIssue({ code: "custom", path: ["streams"], message: "Duplicate stream index" });
  }

  const selectedVideo = report.selectedVideoStreamIndex === null
    ? undefined
    : streamsByIndex.get(report.selectedVideoStreamIndex);
  if (report.selectedVideoStreamIndex !== null && selectedVideo?.kind !== "video") {
    context.addIssue({ code: "custom", path: ["selectedVideoStreamIndex"], message: "Selected video stream is missing" });
  }
  if (report.selectedVideoStreamIndex === null && report.streams.some((stream) => stream.kind === "video")) {
    context.addIssue({ code: "custom", path: ["selectedVideoStreamIndex"], message: "Video source requires a selected video stream" });
  }

  const input = report.mediaInputs[0];
  if (input === undefined) return;
  const expectedKind = selectedVideo === undefined ? "audio" : "video";
  if (input.descriptor.mediaKind !== expectedKind) {
    context.addIssue({ code: "custom", path: ["mediaInputs", 0, "descriptor", "mediaKind"], message: "File kind does not match its probe" });
  }

  let startUs: bigint | undefined;
  let endUs: bigint | undefined;
  for (const stream of report.streams) {
    const start = BigInt(stream.startUs);
    const end = BigInt(stream.endUs);
    startUs = startUs === undefined || start < startUs ? start : startUs;
    endUs = endUs === undefined || end > endUs ? end : endUs;
  }
  if (startUs === undefined || endUs === undefined ||
      input.sourceRange.startUs !== String(startUs) || input.sourceRange.endUs !== String(endUs)) {
    context.addIssue({ code: "custom", path: ["mediaInputs", 0, "sourceRange"], message: "Source range must cover the complete file timeline" });
  }
});

/** A validated probe report for one source file. */
export type LongMediaProbeReport = z.infer<typeof LongMediaProbeReportSchema>;

/** A validated source-file input descriptor. */
export type MediaInputDescriptor = z.infer<typeof MediaInputDescriptorSchema>;

/** One file on the immutable source timeline. */
export type LongMediaInput = z.infer<typeof LongMediaInputSchema>;

/** A measured stream's time range on the source timeline. */
export type LongMediaStream = z.infer<typeof LongMediaStreamSchema>;
