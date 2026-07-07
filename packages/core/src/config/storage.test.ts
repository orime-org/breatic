// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { getStorageConfig } from "@core/config/storage.js";

/** Pins the shipped config/storage.yaml download-retry defaults (#1625 Slice 2). */
describe("getStorageConfig", () => {
  it("loads the download retry config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.download.max_attempts).toBe(3);
    expect(cfg.download.retry_base_delay_ms).toBe(500);
  });

  // Asset upload slice 2 (#1609): every file is hashed (no size line —
  // user decision 2026-07-07 superseding the earlier 500MB line) and a
  // configurable upload cap protects storage cost + local-mode memory.
  it("loads the upload config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.upload.max_upload_bytes).toBe(2147483648);
    expect(cfg.upload.client_max_attempts).toBe(3);
    expect(cfg.upload.client_retry_base_delay_ms).toBe(1000);
    expect(cfg.upload.client_request_timeout_ms).toBe(30000);
    expect(cfg.upload.client_put_min_bytes_per_sec).toBe(65536);
  });

  it("returns a cached, frozen object", () => {
    expect(getStorageConfig()).toBe(getStorageConfig());
    expect(Object.isFrozen(getStorageConfig())).toBe(true);
  });
});
