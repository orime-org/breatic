// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media understanding — give it media and a question, get an answer.
 *
 * Everything about who to ask is an input: the model, the backend, the
 * credential and the address. This package does not read the model catalog or
 * any configuration, which is what lets the agent tool, the worker's canvas
 * task and whatever comes after them each decide those for themselves.
 */

export { understandMedia } from "@domain/understand/understand.js";
export { fetchMedia } from "@domain/understand/fetch-media.js";
export { MediaUnavailable, UnderstandRefused } from "@domain/understand/types.js";
export type {
  Media,
  MediaKind,
  UnavailableKind,
  UnderstandAnswer,
  UnderstandRequest,
  FetchMediaRequest,
} from "@domain/understand/types.js";
