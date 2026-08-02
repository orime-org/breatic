// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { getStorageConfig, storageConfigSchema } from "@core/config/storage.js";

/** The avatar cap the yaml ships, in bytes. */
const SHIPPED_AVATAR_CAP = 2097152;

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

  it("loads the avatar cap from config/storage.yaml", () => {
    // Sized against a measured worst case for one 512² RGBA frame with random
    // pixels AND random alpha (1,049,473 bytes), doubled. A cap below that
    // refuses legitimate crops of detailed pictures; the number is worth
    // pinning because nothing else in the repo would notice it moving.
    expect(getStorageConfig().avatar.max_bytes).toBe(SHIPPED_AVATAR_CAP);
  });

  it("returns a cached, frozen object", () => {
    expect(getStorageConfig()).toBe(getStorageConfig());
    expect(Object.isFrozen(getStorageConfig())).toBe(true);
  });
});

/**
 * The paths a loaded config cannot exercise: what comes back when the yaml
 * says nothing.
 *
 * This is the regression test for a defect that shipped and was fixed here —
 * `avatar.max_bytes` had its number written into two separate `.default()`
 * calls, and they drifted: the section-level one stayed at 1 MiB after the
 * key-level one moved to 2 MiB. Nothing failed, because nothing looked.
 */
describe("storageConfigSchema defaults", () => {
  it("gives the same avatar cap whether the section is absent or empty", () => {
    // The two defaults, reached one each. Equality between them is the whole
    // property — a test that checked only one would have passed throughout the
    // window when they disagreed.
    const sectionAbsent = storageConfigSchema.parse({});
    const sectionEmpty = storageConfigSchema.parse({ avatar: {} });

    expect(sectionAbsent.avatar.max_bytes).toBe(sectionEmpty.avatar.max_bytes);
    expect(sectionAbsent.avatar.max_bytes).toBe(SHIPPED_AVATAR_CAP);
  });

  it("refuses a section written as a bare key rather than defaulting", () => {
    // `avatar:` with nothing under it is YAML null, which is how a section
    // gets commented out in practice. zod rejects it rather than falling back,
    // so that edit is a startup error and not a silent change of limit —
    // pinned because the opposite would be a plausible thing to assume.
    expect(() => storageConfigSchema.parse({ avatar: null })).toThrow();
  });

  it("defaults every section, not just the one that was fixed", () => {
    const cfg = storageConfigSchema.parse({});

    expect(cfg.download.max_attempts).toBe(3);
    expect(cfg.download.retry_base_delay_ms).toBe(500);
    expect(cfg.upload.max_upload_bytes).toBe(2147483648);
    expect(cfg.upload.presign_expires_seconds).toBe(300);
  });
});
