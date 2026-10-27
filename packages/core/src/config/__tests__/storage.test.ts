// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

import { getStorageConfig, storageConfigSchema } from "@core/config/storage.js";

/** The upload cap the yaml ships, in bytes. */
const SHIPPED_UPLOAD_CAP = 2147483648;

/** Pins what the shipped config/storage.yaml guarantees its callers. */
describe("getStorageConfig", () => {
  // Asset upload slice 2 (#1609): every file is hashed (no size line —
  // user decision 2026-07-07 superseding the earlier 500MB line) and a
  // configurable upload cap protects storage cost + local-mode memory.
  it("loads the upload config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.upload.max_upload_bytes).toBe(SHIPPED_UPLOAD_CAP);
    expect(cfg.upload.client_max_attempts).toBe(3);
    expect(cfg.upload.client_retry_base_delay_ms).toBe(1000);
    expect(cfg.upload.upload_idle_timeout_seconds).toBe(60);
  });

  it("returns a cached, frozen object", () => {
    expect(getStorageConfig()).toBe(getStorageConfig());
    expect(Object.isFrozen(getStorageConfig())).toBe(true);
  });
});

/**
 * The paths a loaded config cannot exercise: what comes back when the yaml
 * says nothing. A number written into two `.default()` calls drifts, and
 * nothing fails, because nothing looks.
 */
describe("storageConfigSchema defaults", () => {
  it("gives the same upload cap whether the section is absent or empty", () => {
    // The two defaults, reached one each. Equality between them is the whole
    // property — a test that checked only one would pass while they disagreed.
    const sectionAbsent = storageConfigSchema.parse({});
    const sectionEmpty = storageConfigSchema.parse({ upload: {} });

    expect(sectionAbsent.upload.max_upload_bytes).toBe(
      sectionEmpty.upload.max_upload_bytes,
    );
    expect(sectionAbsent.upload.max_upload_bytes).toBe(SHIPPED_UPLOAD_CAP);
  });

  it("refuses a section written as a bare key rather than defaulting", () => {
    // `upload:` with nothing under it is YAML null, which is how a section
    // gets commented out in practice. zod rejects it rather than falling back,
    // so that edit is a startup error and not a silent change of limit —
    // pinned because the opposite would be a plausible thing to assume.
    expect(() => storageConfigSchema.parse({ upload: null })).toThrow();
  });
});

/**
 * The ingest Worker's two server-side knobs (#173, design §4.1).
 *
 * `part_size_bytes` is the one with a hard external floor: R2 rejects any
 * non-final part under 5 MiB, so a config below it would fail mid-upload
 * rather than at load, where the operator who typed the number is reading.
 *
 * Nothing here times a task's chain: every wait there is bounded by the task's
 * own deadline (inner#1367).
 */
describe("storageConfigSchema — the ingest knobs", () => {
  it("loads the ingest config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.ingest.part_size_bytes).toBe(8388608);
    expect(cfg.ingest.ticket_expires_seconds).toBe(300);
  });

  // Read off disk: the schema drops keys it does not know, so a knob left in
  // the file would never show up in what it parses.
  it("holds no time of its own for any wait on a task's chain", () => {
    const path = resolve(import.meta.dirname, "../../../../../config/storage.yaml");
    const cfg = parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    for (const key of [
      "session_token_ttl_seconds",
      "container_run_deadline_ms",
      "container_tool_timeout_ms",
      "url_fetch_deadline_ms",
    ]) {
      expect(cfg.ingest).not.toHaveProperty(key);
    }
    for (const key of ["client_request_timeout_ms", "client_put_min_bytes_per_sec"]) {
      expect(cfg.upload).not.toHaveProperty(key);
    }
  });

  it("refuses a part size R2 would reject as a non-final part", () => {
    expect(() =>
      storageConfigSchema.parse({ ingest: { part_size_bytes: 5 * 1024 * 1024 - 1 } }),
    ).toThrow(/part_size_bytes/);

    expect(() =>
      storageConfigSchema.parse({ ingest: { part_size_bytes: 5 * 1024 * 1024 } }),
    ).not.toThrow();
  });

  it("defaults the whole section whether it is absent or empty", () => {
    const defaulted = storageConfigSchema.parse({});
    const empty = storageConfigSchema.parse({ ingest: {} });
    expect(defaulted.ingest).toEqual(empty.ingest);
    expect(defaulted.ingest.part_size_bytes).toBe(8388608);
  });
});

/** A part is cut once its bytes stop moving, never for being slow (inner#1367). */
describe("storageConfigSchema — the idle window", () => {
  it("refuses an idle window that is not a positive number of seconds", () => {
    expect(() =>
      storageConfigSchema.parse({ upload: { upload_idle_timeout_seconds: 0 } }),
    ).toThrow(/upload_idle_timeout_seconds/);
  });
});

/**
 * T15 (inner#1006 §4.1): the transfer section. Each route's cap is counted
 * over the whole transfer file, signature included; a finished transfer can be
 * referenced for an hour; one user's read holds its lock for a minute, and a
 * second read of the same user waits for it, trying again every 100 ms for up
 * to ten seconds.
 */
describe("storageConfigSchema — the transfer section", () => {
  const TRANSFER_DEFAULTS = {
    route_max_bytes: {
      chat_message: 4194304,
      canvas_paste: 25165824,
      node_history_snapshot: 25165824,
    },
    reference_ttl_seconds: 3600,
    read_lock_seconds: 60,
    read_lock_wait_seconds: 10,
    read_lock_retry_ms: 100,
  };

  it("(a) defaults the whole section when the yaml has none", () => {
    const parsed = storageConfigSchema.parse({}) as unknown as { transfer?: unknown };
    expect(parsed.transfer).toEqual(TRANSFER_DEFAULTS);
  });

  it("(b) defaults every key the yaml leaves out", () => {
    const parsed = storageConfigSchema.parse({
      transfer: { reference_ttl_seconds: 10 },
    }) as unknown as { transfer?: unknown };
    expect(parsed.transfer).toEqual({ ...TRANSFER_DEFAULTS, reference_ttl_seconds: 10 });
  });

  it("(c) loads the same figures from config/storage.yaml", () => {
    const loaded = getStorageConfig() as unknown as { transfer?: unknown };
    expect(loaded.transfer).toEqual(TRANSFER_DEFAULTS);
  });

  it("(d) gives transfer-ticket its own rate limit in config/rate-limits.yaml", () => {
    const limits = parse(
      readFileSync(resolve(import.meta.dirname, "../../../../../config/rate-limits.yaml"), "utf8"),
    ) as Record<string, unknown>;
    expect(limits["transfer-ticket"]).toEqual({ max: 10, window_seconds: 60 });
  });
});
