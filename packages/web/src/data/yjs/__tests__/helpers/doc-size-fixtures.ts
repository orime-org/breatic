// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790): the wire form of a `doc:size` push.
 */

/**
 * The wire payload of one push, as collab sends it on the provider's stateless channel.
 * @param push - The fixture, optionally with extra or broken fields.
 * @returns The serialized `doc:size` message.
 * @throws {never} Never.
 */
export function docSizePayload(push: object): string {
  return JSON.stringify({ type: 'doc:size', ...push });
}
