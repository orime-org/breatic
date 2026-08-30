// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import { MAX_TIMER_MS } from "@breatic/shared";

import { getStorageConfig, storageConfigSchema } from "@core/config/storage.js";

/** The avatar cap the yaml ships, in bytes. */
const SHIPPED_AVATAR_CAP = 2097152;

/** Pins what the shipped config/storage.yaml guarantees its callers. */
describe("getStorageConfig", () => {
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

    expect(cfg.upload.max_upload_bytes).toBe(2147483648);
    expect(cfg.upload.presign_expires_seconds).toBe(300);
  });
});

/**
 * The pair of upload knobs that has to be judged together.
 *
 * The browser sizes its PUT stall guard as `max_upload_bytes / rate`, and
 * hands the result to the shared HTTP transport as a per-delivery deadline.
 * The transport refuses a deadline a timer cannot hold — deliberately, rather
 * than clamping — so a rate low enough to push the biggest allowed upload past
 * {@link MAX_TIMER_MS} makes every such PUT fail before a single byte leaves,
 * with an error written for a programmer and not for the person uploading.
 *
 * Nothing about that is the uploader's doing, and nothing we promised covers
 * an arbitrary rate. So the refusal belongs here, at load, where the operator
 * who typed the number is the one who reads the message.
 */
describe("storageConfigSchema — the stall guard has to stay expressible", () => {
  /** The shipped cap, and the lowest rate that can still serve it. */
  const SHIPPED_CAP = 2147483648;
  const LOWEST_USABLE_RATE = 1001;

  it("accepts the lowest rate that still serves the shipped cap", () => {
    const cfg = storageConfigSchema.parse({
      upload: { client_put_min_bytes_per_sec: LOWEST_USABLE_RATE },
    });
    expect(cfg.upload.client_put_min_bytes_per_sec).toBe(LOWEST_USABLE_RATE);
    // The property behind the number, so this test still means something if
    // either constant moves.
    expect(
      Math.ceil((cfg.upload.max_upload_bytes / LOWEST_USABLE_RATE) * 1000),
    ).toBeLessThanOrEqual(MAX_TIMER_MS);
  });

  it("refuses the rate one below it, and says what the floor is", () => {
    expect(() =>
      storageConfigSchema.parse({
        upload: { client_put_min_bytes_per_sec: LOWEST_USABLE_RATE - 1 },
      }),
    ).toThrow(/client_put_min_bytes_per_sec/);
    expect(() =>
      storageConfigSchema.parse({
        upload: { client_put_min_bytes_per_sec: LOWEST_USABLE_RATE - 1 },
      }),
    ).toThrow(new RegExp(String(LOWEST_USABLE_RATE)));
  });

  it("moves the floor when the upload cap moves", () => {
    // The two knobs are judged together, not each against a constant. Doubling
    // the cap doubles what the rate has to be, so a rate that was fine a
    // moment ago is not. A bound written against the rate alone would let this
    // through, and the guard would be unusable again at the new cap.
    expect(() =>
      storageConfigSchema.parse({
        upload: {
          max_upload_bytes: SHIPPED_CAP * 2,
          client_put_min_bytes_per_sec: LOWEST_USABLE_RATE,
        },
      }),
    ).toThrow(/client_put_min_bytes_per_sec/);

    expect(() =>
      storageConfigSchema.parse({
        upload: {
          max_upload_bytes: SHIPPED_CAP * 2,
          client_put_min_bytes_per_sec: LOWEST_USABLE_RATE * 2,
        },
      }),
    ).not.toThrow();
  });

  it("refuses a floor a timer cannot hold either", () => {
    // The deadline is max(floor, size/rate), so the floor is the second way to
    // produce an unusable figure — and the one a rate-only bound would miss.
    // Enumerated rather than waited for: the invariant is about the deadline,
    // not about one of the two knobs that feed it.
    expect(() =>
      storageConfigSchema.parse({
        upload: { client_request_timeout_ms: MAX_TIMER_MS + 1 },
      }),
    ).toThrow(/client_request_timeout_ms/);

    expect(() =>
      storageConfigSchema.parse({
        upload: { client_request_timeout_ms: MAX_TIMER_MS },
      }),
    ).not.toThrow();
  });

  it("leaves the shipped pair alone", () => {
    expect(() => storageConfigSchema.parse({})).not.toThrow();
    expect(getStorageConfig().upload.client_put_min_bytes_per_sec).toBe(65536);
  });
});

/**
 * The ingest Worker's two server-side knobs (#173, design §4.1).
 *
 * `part_size_bytes` is the one with a hard external floor: R2 rejects any
 * non-final part under 5 MiB, so a config below it would fail mid-upload
 * rather than at load, where the operator who typed the number is reading.
 *
 * `alarm_idle_seconds` has no such bound. It is how long an upload may go
 * without a new part before the Durable Object judges it dead, and the object
 * pushes its alarm out by this much on every part it receives — so there is no
 * total upload time to keep it under, and nothing to nest it inside.
 */
describe("storageConfigSchema — the ingest knobs", () => {
  it("loads the ingest config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.ingest.part_size_bytes).toBe(8388608);
    expect(cfg.ingest.ticket_expires_seconds).toBe(300);
    expect(cfg.ingest.alarm_idle_seconds).toBe(300);
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
