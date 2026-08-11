// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { endpointForMode } from "@worker/providers/video/transports/klingai.js";

/**
 * #1904 — which KlingAI endpoint a request goes to follows the generation
 * mode, not whichever param name happens to be present.
 *
 * The job carries no generation mode (`job.data.mode` is the node's
 * append/overwrite write mode), so the model's declared `mode` is the only
 * source, and it may be a list.
 */
describe("endpointForMode (#1904)", () => {
  it("routes each mode to its endpoint", () => {
    expect(endpointForMode("t2v")).toBe("text2video");
    expect(endpointForMode("i2v")).toBe("image2video");
    expect(endpointForMode("first_last")).toBe("image2video");
    // Reference-to-video has its own endpoint. Reading the mode off the param
    // names sent it to text2video, because its param is `images` and nothing
    // in that chain matched.
    expect(endpointForMode("ref")).toBe("multi-image2video");
  });

  it("takes the single endpoint a multi-mode model agrees on", () => {
    // `kling-o3-pro-i2v` declares both, and both are image2video.
    expect(endpointForMode(["i2v", "first_last"])).toBe("image2video");
  });

  it("refuses a model whose modes disagree instead of picking one", () => {
    // Nothing declares such a mode set today. If something ever does, the
    // model alone cannot answer the question and silently picking the first
    // would post to an endpoint the caller never asked for. The message names
    // the modes so the log says which model needs looking at.
    expect(() => endpointForMode(["t2v", "i2v"])).toThrow(
      /t2v.*i2v|i2v.*t2v/,
    );
  });

  it("refuses a mode it has no endpoint for", () => {
    expect(() => endpointForMode("no-such-mode")).toThrow(/no-such-mode/);
    expect(() => endpointForMode([])).toThrow(/mode/i);
  });

  it("keeps today's endpoint for the two modes whose mapping is unverified", () => {
    // Neither vendor endpoint list carries `video2video`, and the endpoint
    // for motion control could not be established (#1910). Both keep exactly
    // what the param-name chain produced today, so this change moves nothing
    // for the models that use them.
    expect(endpointForMode("edit")).toBe("video2video");
    expect(endpointForMode("motion")).toBe("image2video");
  });
});
