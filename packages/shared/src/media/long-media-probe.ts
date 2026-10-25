// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { MediaInputDescriptorSchema } from "@shared/media/long-media-schema.js";

const signedIntegerText = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const positiveIntegerText = z.string().regex(/^[1-9][0-9]*$/);

const timeRange = z.object({ startUs: signedIntegerText, endUs: signedIntegerText }).strict()
  .refine((range) => BigInt(range.startUs) < BigInt(range.endUs), "Invalid source time range");

const timeBase = z.object({ numerator: positiveIntegerText, denominator: positiveIntegerText }).strict();

const stream = z.discriminatedUnion("kind", [
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.literal("audio"),
    codec: z.string().min(1),
    channels: z.number().int().positive(),
    channelLayout: z.string().min(1),
    channelMembers: z.array(z.object({
      channelIndex: z.number().int().nonnegative(),
      member: z.string().min(1),
    }).strict()),
    sampleRate: z.number().int().positive(),
    startUs: signedIntegerText,
    endUs: signedIntegerText,
    timeBase,
  }).strict().refine((value) => BigInt(value.startUs) < BigInt(value.endUs), "Invalid audio stream range"),
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.literal("video"),
    codec: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    startUs: signedIntegerText,
    endUs: signedIntegerText,
    timeBase,
  }).strict().refine((value) => BigInt(value.startUs) < BigInt(value.endUs), "Invalid video stream range"),
]);

export const LongMediaInputSchema = z.object({
  mediaInputId: z.string().min(1),
  descriptor: MediaInputDescriptorSchema,
  sourceRange: timeRange,
  videoRange: timeRange.optional(),
  audioRange: timeRange.optional(),
}).strict();

/** Probe facts needed to freeze all required media inputs for one immutable source. */
export const LongMediaProbeReportSchema = z.object({
  version: z.literal(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  selectedVideoStreamIndex: z.number().int().nonnegative().nullable(),
  streams: z.array(stream).min(1),
  mediaInputs: z.array(LongMediaInputSchema).min(1),
}).strict().superRefine((report, context) => {
  const streamsByIndex = new Map(report.streams.map((item) => [item.index, item]));
  const selectedVideo = report.selectedVideoStreamIndex === null
    ? undefined
    : streamsByIndex.get(report.selectedVideoStreamIndex);
  if (report.selectedVideoStreamIndex !== null && selectedVideo?.kind !== "video") {
    context.addIssue({ code: "custom", path: ["selectedVideoStreamIndex"], message: "Selected video stream is missing" });
  }
  if (report.selectedVideoStreamIndex === null && report.streams.some((item) => item.kind === "video")) {
    context.addIssue({ code: "custom", path: ["selectedVideoStreamIndex"], message: "Video source requires a selected video stream" });
  }
  if (streamsByIndex.size !== report.streams.length) {
    context.addIssue({ code: "custom", path: ["streams"], message: "Duplicate stream index" });
  }

  for (const [streamIndex, item] of streamsByIndex) {
    if (item.kind !== "audio") continue;
    const channelIndexes = item.channelMembers.map((channel) => channel.channelIndex).sort((a, b) => a - b);
    const complete = channelIndexes.length === item.channels && channelIndexes.every((index, position) => index === position);
    if (!complete) {
      context.addIssue({ code: "custom", path: ["streams", streamIndex, "channelMembers"], message: "Incomplete channel mapping" });
    }
    const knownMembers = item.channelMembers.filter((channel) => channel.member !== "unknown");
    if (new Set(knownMembers.map((channel) => channel.member)).size !== knownMembers.length) {
      context.addIssue({ code: "custom", path: ["streams", streamIndex, "channelMembers"], message: "Duplicate channel mapping member" });
    }
  }

  const inputIds = new Set<string>();
  const mappedChannels = new Set<string>();
  for (const [inputIndex, input] of report.mediaInputs.entries()) {
    if (inputIds.has(input.mediaInputId)) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "mediaInputId"], message: "Duplicate media input id" });
    }
    inputIds.add(input.mediaInputId);

    const { descriptor } = input;
    if (descriptor.inputKind === "video_silent") {
      const video = streamsByIndex.get(descriptor.videoStreamIndex);
      if (video?.kind !== "video" || descriptor.videoStreamIndex !== report.selectedVideoStreamIndex || report.streams.some((item) => item.kind === "audio")) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor"], message: "Invalid silent video stream" });
      }
      if (input.videoRange === undefined || input.audioRange !== undefined) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex], message: "Silent video requires only a video range" });
      } else if (video?.kind === "video" && (input.videoRange.startUs !== video.startUs || input.videoRange.endUs !== video.endUs)) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "videoRange"], message: "Video range does not match the probed stream" });
      }
      if (input.videoRange !== undefined && !sameRange(input.sourceRange, input.videoRange)) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "sourceRange"], message: "Source range must equal the video range envelope" });
      }
      continue;
    }

    if (selectedVideo === undefined && descriptor.inputKind !== "audio_channel") {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor"], message: "Audio-only source requires an audio channel input" });
    }
    if (selectedVideo !== undefined && (descriptor.inputKind !== "video_channel" || descriptor.videoStreamIndex !== selectedVideo.index)) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor"], message: "Selected video must be preserved in every audio channel input" });
    }

    const audio = streamsByIndex.get(descriptor.audioStreamIndex);
    if (audio?.kind !== "audio") {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor"], message: "Audio descriptor references a missing audio stream" });
      continue;
    }
    if (descriptor.audioChannelIndex >= audio.channels) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor", "audioChannelIndex"], message: "Audio channel index exceeds probed channel count" });
    }
    if (input.audioRange === undefined) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "audioRange"], message: "Audio input requires an audio range" });
    } else if (input.audioRange.startUs !== audio.startUs || input.audioRange.endUs !== audio.endUs) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "audioRange"], message: "Audio range does not match the probed stream" });
    }
    const channelKey = `${descriptor.audioStreamIndex}:${descriptor.audioChannelIndex}`;
    if (mappedChannels.has(channelKey)) {
      context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor"], message: "Duplicate audio channel mapping" });
    }
    mappedChannels.add(channelKey);
    if (descriptor.inputKind === "video_channel") {
      const video = streamsByIndex.get(descriptor.videoStreamIndex);
      if (video?.kind !== "video") {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "descriptor", "videoStreamIndex"], message: "Video descriptor references a missing video stream" });
      }
      if (input.videoRange === undefined) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "videoRange"], message: "Video channel input requires a video range" });
      } else if (video?.kind === "video" && (input.videoRange.startUs !== video.startUs || input.videoRange.endUs !== video.endUs)) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "videoRange"], message: "Video range does not match the probed stream" });
      }
      if (input.videoRange !== undefined && input.audioRange !== undefined &&
          !sameRange(input.sourceRange, envelopeOf(input.videoRange, input.audioRange))) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "sourceRange"], message: "Source range must equal the video and audio range envelope" });
      }
    } else {
      if (input.videoRange !== undefined) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "videoRange"], message: "Audio-only input cannot carry a video range" });
      }
      if (input.audioRange !== undefined && !sameRange(input.sourceRange, input.audioRange)) {
        context.addIssue({ code: "custom", path: ["mediaInputs", inputIndex, "sourceRange"], message: "Source range must equal the audio range" });
      }
    }
  }

  for (const item of report.streams) {
    if (item.kind !== "audio") continue;
    for (let channelIndex = 0; channelIndex < item.channels; channelIndex += 1) {
      if (!mappedChannels.has(`${item.index}:${channelIndex}`)) {
        context.addIssue({ code: "custom", path: ["mediaInputs"], message: `Missing required input for audio channel ${item.index}:${channelIndex}` });
      }
    }
  }
  if (selectedVideo !== undefined && !report.streams.some((item) => item.kind === "audio") &&
      !report.mediaInputs.some((input) => input.descriptor.inputKind === "video_silent" && input.descriptor.videoStreamIndex === selectedVideo.index)) {
    context.addIssue({ code: "custom", path: ["mediaInputs"], message: "Missing required silent video input" });
  }
});

/**
 * Return the range spanning two measured source ranges.
 * @param left - The first range.
 * @param right - The second range.
 * @returns The minimum start and maximum end.
 */
function envelopeOf(left: z.infer<typeof timeRange>, right: z.infer<typeof timeRange>): z.infer<typeof timeRange> {
  return {
    startUs: BigInt(left.startUs) < BigInt(right.startUs) ? left.startUs : right.startUs,
    endUs: BigInt(left.endUs) > BigInt(right.endUs) ? left.endUs : right.endUs,
  };
}

/**
 * Compare two already validated source ranges.
 * @param left - The first range.
 * @param right - The second range.
 * @returns Whether both endpoints match exactly.
 */
function sameRange(left: z.infer<typeof timeRange>, right: z.infer<typeof timeRange>): boolean {
  return left.startUs === right.startUs && left.endUs === right.endUs;
}

/** A trusted stream and per-channel probe report. */
export type LongMediaProbeReport = z.infer<typeof LongMediaProbeReportSchema>;

/**
 * Validate untrusted container probe output before it can define required inputs.
 * @param value - The decoded container response.
 * @returns The validated immutable-source probe facts.
 * @throws {z.ZodError} when stream identity, channel mapping or time facts are invalid.
 */
export function readLongMediaProbeReport(value: unknown): LongMediaProbeReport {
  return LongMediaProbeReportSchema.parse(value);
}
