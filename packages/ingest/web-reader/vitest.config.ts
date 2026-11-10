// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The page reader's service tests (inner#1664). They run on Node: the service
 * itself runs on Node in its own image, so neither workerd nor the media
 * container's project describes it.
 */

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: __dirname,
  test: {
    name: "web-reader",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: { "@shared": resolve(__dirname, "../../shared/src") },
  },
});
