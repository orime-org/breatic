// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

const streamIndex = z.number().int().nonnegative();
const channelIndex = z.number().int().nonnegative();

/** A required audio stream channel, with no invented video identity. */
const audioChannel = z.object({
  inputKind: z.literal("audio_channel"),
  audioStreamIndex: streamIndex,
  audioChannelIndex: channelIndex,
}).strict();

/** A video stream observed alongside one independently derived audio channel. */
const videoChannel = z.object({
  inputKind: z.literal("video_channel"),
  videoStreamIndex: streamIndex,
  audioStreamIndex: streamIndex,
  audioChannelIndex: channelIndex,
}).strict();

/** A video stream whose trusted probe found no audio stream. */
const silentVideo = z.object({
  inputKind: z.literal("video_silent"),
  videoStreamIndex: streamIndex,
}).strict();

/** Strict identity of one required audio channel or video observation input. */
export const MediaInputDescriptorSchema = z.discriminatedUnion("inputKind", [
  audioChannel,
  videoChannel,
  silentVideo,
]);

/** One probe-derived input the operation must cover independently. */
export type MediaInputDescriptor = z.infer<typeof MediaInputDescriptorSchema>;
