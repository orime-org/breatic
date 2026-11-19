// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extension an object is stored under for each media type the worker writes: a generation result whose model
 * declares its type (inner#1305) and a mini-tool step object, whose type a model reads from its link (VACE fails one
 * without).
 */
export const EXTENSION_OF_TYPE: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/webm": ".webm",
  "text/plain": ".txt",
};
