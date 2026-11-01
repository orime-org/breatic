// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's answer to the agent's request to read Spaces, held to the
 * request it answers (inner#1552).
 *
 * Shared because the route takes the answer and the browser builds it from
 * the same request. Only structure is checked here; content length is checked
 * by the route against config this package cannot read.
 */
import type { SharedSpace, SpaceRequestAnswer, SpaceRequestInput } from "@shared/schemas/api.js";

type AskedSpace = SpaceRequestInput["spaces"][number];

/**
 * Why one Space's answer does not fit how it was asked for.
 * @param asked - The request entry.
 * @param shared - The Space as the browser read it.
 * @returns Why it does not fit, or null when it does.
 */
function spaceMismatch(asked: AskedSpace, shared: SharedSpace): string | null {
  const part = shared.part;
  const byBlocks = asked.blocks !== undefined;
  const byNodes = asked.node_ids !== undefined;
  if (byBlocks) {
    if (part === undefined || !("blocks" in part)) return `Space ${asked.id} was asked for by blocks.`;
    if (part.blocks.from !== asked.blocks?.from || part.blocks.to !== asked.blocks.to) {
      return `Space ${asked.id} answers another range of blocks.`;
    }
  } else if (byNodes) {
    if (part === undefined || !("node_ids" in part)) return `Space ${asked.id} was asked for by nodes.`;
    if (JSON.stringify(part.node_ids) !== JSON.stringify(asked.node_ids)) return `Space ${asked.id} answers other nodes.`;
  } else if (part !== undefined) {
    return `Space ${asked.id} was asked for whole.`;
  }
  const read = shared.state === "read";
  const blocksTotal = "blocks_total" in shared && shared.blocks_total !== undefined;
  const nodesMissing = "nodes_missing" in shared && shared.nodes_missing !== undefined;
  if (blocksTotal !== (read && byBlocks)) return `Space ${asked.id} carries a block count only when a range of it was read.`;
  if (nodesMissing !== (read && byNodes)) return `Space ${asked.id} carries a missing-node count only when its nodes were read.`;
  return null;
}

/**
 * Why the reader's answer does not fit the request it answers: each Space
 * asked for is answered once, nothing else is, and each answers the part it
 * was asked for.
 * @param input - The request as the agent made it.
 * @param answer - What the browser sent.
 * @returns Why it does not fit, or null when it does.
 */
export function spaceAnswerMismatch(input: SpaceRequestInput, answer: SpaceRequestAnswer): string | null {
  if (answer.decision === "declined") return null;
  const asked = new Map(input.spaces.map((space) => [space.id, space]));
  const seen = new Set<string>();
  for (const shared of answer.spaces) {
    const entry = asked.get(shared.id);
    if (entry === undefined) return `Space ${shared.id} was not asked for.`;
    if (seen.has(shared.id)) return `Space ${shared.id} is answered twice.`;
    seen.add(shared.id);
    const why = spaceMismatch(entry, shared);
    if (why !== null) return why;
  }
  if (seen.size !== asked.size) return "Every Space asked for is answered.";
  return null;
}
