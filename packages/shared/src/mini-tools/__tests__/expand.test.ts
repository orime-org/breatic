// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The expand tool (inner#1303 §5, §6.3): the picture padded onto a larger
 * canvas and a mask of the new area go to the pinned fill model in place of
 * the source.
 */

import { describe, it, expect } from "vitest";

import {
  miniToolById,
  miniToolEstimateInput,
  miniToolRequestMemberSchema,
  toolFilledParams,
  type MiniToolSpec,
} from "@shared/mini-tools/index.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";

/**
 * The expand tool.
 * @returns Its declaration.
 */
function expand(): MiniToolSpec {
  const spec = miniToolById("image.expand");
  if (!spec) throw new Error("image.expand");
  return spec;
}

describe("image.expand", () => {
  it("fills the pinned fill model's picture and mask, with a prompt it can leave empty", () => {
    const spec = expand();
    expect(spec.run).toEqual({ kind: "model", model: "bria-genfill" });
    expect(spec.expand).toEqual({ imageParam: "image", maskParam: "mask_image" });
    expect(spec.prompt?.defaultText).toMatch(/^[A-Za-z ,.'-]+$/);
    expect(toolFilledParams(spec)).toEqual(["image", "mask_image"]);
  });

  it("sends the padded picture and its mask in place of the source", () => {
    const input = miniToolEstimateInput(expand(), {
      params: {},
      prompt: "",
      source: { url: "https://cdn/src.png" },
      slots: {},
      expand: { image: "https://cdn/padded.png", mask: "https://cdn/mask.png" },
    });
    expect(input.params).toMatchObject({ image: "https://cdn/padded.png", mask_image: "https://cdn/mask.png" });
  });

  it("asks the request for the padded picture and the mask", () => {
    const schema = miniToolRequestMemberSchema(expand());
    const body = {
      tool: "image.expand",
      project_id: PID,
      space_id: SID,
      node_ids: [NODE],
      source: { url: "https://cdn/src.png" },
      prompt: "",
      params: {},
      slots: {},
    };
    expect(schema.safeParse(body).success).toBe(false);
    expect(
      schema.safeParse({ ...body, expand: { image: "https://cdn/padded.png", mask: "https://cdn/mask.png" } }).success,
    ).toBe(true);
  });
});
