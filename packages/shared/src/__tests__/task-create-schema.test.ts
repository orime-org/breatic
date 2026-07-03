// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * taskCreateSchema contract tests — #1580 #7 unified gen fencing.
 *
 * The REST body is where a lease generation enters the backend: the
 * frontend (the original trigger, the only party that can read the node's
 * `leaseGen`) sends `node_gens` (nodeId → gen) alongside the target node
 * ids. The server threads each gen into the BullMQ job and the
 * handling-open event; the worker echoes it back; collab CAS-checks it.
 * Pre-launch → the field is REQUIRED whenever the task binds to nodes.
 */

import { describe, it, expect } from "vitest";
import { taskCreateSchema } from "../schemas/api.js";

const NODE_ID = "9f8b3c2a-1d4e-4f6a-8b7c-0a1b2c3d4e5f";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const SPACE_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";

/**
 * Build a minimal valid overwrite-mode body; tests override single fields.
 * @param overrides - Fields to override on the base body.
 * @returns The body object for `taskCreateSchema.safeParse`.
 */
function overwriteBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    task_type: "image",
    params: {},
    project_id: PROJECT_ID,
    space_id: SPACE_ID,
    mode: "overwrite",
    target_node_id: NODE_ID,
    node_gens: { [NODE_ID]: 4 },
    ...overrides,
  };
}

describe("taskCreateSchema node_gens (#1580 #7)", () => {
  it("accepts an overwrite body whose node_gens covers the target node", () => {
    const parsed = taskCreateSchema.safeParse(overwriteBody());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.node_gens).toEqual({ [NODE_ID]: 4 });
    }
  });

  it("rejects a node-bound body without node_gens", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({ node_gens: undefined }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects node_gens that does not cover the target node id", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({
        node_gens: { "00000000-0000-4000-8000-000000000000": 4 },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-positive gen", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({ node_gens: { [NODE_ID]: 0 } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-integer gen", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({ node_gens: { [NODE_ID]: 1.5 } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts an unbound task (no target node) without node_gens", () => {
    const parsed = taskCreateSchema.safeParse({
      task_type: "understand",
      params: {},
      project_id: PROJECT_ID,
      space_id: SPACE_ID,
      mode: "append",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("gen upper bound (#1580 adversarial: MAX_SAFE_INTEGER bricks the counter)", () => {
  it("rejects a gen above the 2^31-1 cap (counter-flooding guard)", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({ node_gens: { [NODE_ID]: Number.MAX_SAFE_INTEGER } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("accepts a gen at the cap boundary", () => {
    const parsed = taskCreateSchema.safeParse(
      overwriteBody({ node_gens: { [NODE_ID]: 2_147_483_647 } }),
    );
    expect(parsed.success).toBe(true);
  });
});
