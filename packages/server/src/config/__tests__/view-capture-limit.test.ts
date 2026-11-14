// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A capture upload (#1488 §19.1) is one multipart body on a public route: the
 * image, at most `view_capture.max_bytes` from `config/mcp.yaml`, plus the
 * on-screen data, at most `VIEW_CAPTURE_VIEW_MAX_BYTES`. The whole body has to
 * fit under `request_body_max_bytes` from `config/limits.yaml`, which refuses
 * anything larger before the route runs. The two numbers live in two files, so
 * an operator raising one would turn every full-size capture into a 413.
 */

import { describe, it, expect } from "vitest";
import { getMcpConfig } from "@breatic/core";
import { VIEW_CAPTURE_VIEW_MAX_BYTES } from "@breatic/shared";
import { getRequestBodyMaxBytes } from "@server/config/limits.js";

describe("capture upload size", () => {
  it("fits the largest image and its on-screen data under the request body limit", () => {
    expect(getMcpConfig().view_capture.max_bytes + VIEW_CAPTURE_VIEW_MAX_BYTES).toBeLessThanOrEqual(
      getRequestBodyMaxBytes(),
    );
  });

  it("allows 64 KiB of on-screen data", () => {
    expect(VIEW_CAPTURE_VIEW_MAX_BYTES).toBe(65_536);
  });
});
