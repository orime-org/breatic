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

  it("returns a cached, frozen object", () => {
    expect(getStorageConfig()).toBe(getStorageConfig());
    expect(Object.isFrozen(getStorageConfig())).toBe(true);
  });
});
