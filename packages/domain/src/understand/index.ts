// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media understanding — give it an address and a question, get an answer.
 *
 * One way in. Getting the media and asking about it are two steps with an
 * order and a set of limits between them, and that order is part of the
 * capability rather than something each caller reassembles: the agent tool
 * today, the worker's canvas task and whatever follows would otherwise each
 * carry a copy of it, and each copy would classify failures its own way.
 *
 * Everything about who to ask is an input — the model, the backend, the
 * credential and the address — so this package reads no model catalog and no
 * configuration of its own.
 */

export { understandMediaAt } from "@domain/understand/understand-at.js";
export { MediaUnavailable, UnderstandRefused } from "@domain/understand/types.js";
export type {
  Media,
  MediaKind,
  UnavailableKind,
  UnderstandAnswer,
  UnderstandAt,
} from "@domain/understand/types.js";
