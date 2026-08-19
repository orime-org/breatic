// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The boundary between the shape we store and the shape the wire carries.
 *
 * The transport speaks the SDK's protocol; the store keeps its own layout,
 * because a dependency's model of a message decides how it talks and not how
 * our rows are written. Code can be rewritten when the library changes; rows
 * already written cannot.
 *
 * Design: inner `engineering/specs/2026-08-19-usechat-migration-design.md`
 * 6.4.1.
 */
import type { UIMessage } from "ai";
import type { MessagePart } from "@breatic/shared";

/** What one message's parts look like on the wire. */
type UiParts = UIMessage["parts"];

/**
 * Turn what a finished turn streamed into what gets written down.
 * @param parts - The parts the SDK assembled for this message.
 * @returns The same message in the shape the store keeps.
 * @throws {Error} Always, until this is written.
 */
export function toStoredParts(parts: UiParts): MessagePart[] {
  void parts;
  throw new Error("not implemented");
}

/**
 * Turn a stored message back into what the client renders.
 * @param parts - The parts as they were written down.
 * @returns The same message in the shape the SDK's client reads.
 * @throws {Error} Always, until this is written.
 */
export function toUiParts(parts: MessagePart[]): UiParts {
  void parts;
  throw new Error("not implemented");
}
