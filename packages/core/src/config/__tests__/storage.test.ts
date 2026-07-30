// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { getStorageConfig } from "@core/config/storage.js";

/**
 * Pins the shipped config/storage.yaml defaults.
 *
 * The download-retry assertions that used to open this file are gone with the
 * knobs themselves: retrying an asset transfer is the shared HTTP transport's
 * job now, so no caller has its own count to configure.
 */
describe("getStorageConfig", () => {
  // Asset upload slice 2 (#1609): every file is hashed (no size line —
  // user decision 2026-07-07 superseding the earlier 500MB line) and a
  // configurable upload cap protects storage cost + local-mode memory.
  it("loads the upload config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.upload.max_upload_bytes).toBe(2147483648);
    expect(cfg.upload.client_request_timeout_ms).toBe(30000);
    expect(cfg.upload.client_put_min_bytes_per_sec).toBe(65536);
  });

  it("returns a cached, frozen object", () => {
    expect(getStorageConfig()).toBe(getStorageConfig());
    expect(Object.isFrozen(getStorageConfig())).toBe(true);
  });
});
