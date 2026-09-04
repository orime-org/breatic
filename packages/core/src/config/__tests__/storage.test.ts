// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from "vitest";
import {
  MAX_TIMER_MS,
  partRetryBudgetMs,
  completeRetryBudgetMs,
} from "@breatic/shared";

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
  });
});

/**
 * The knobs that have to be judged together, and across sections.
 *
 * The browser sizes each part's stall guard as `max(floor, part size / rate)`
 * and hands the result to the shared HTTP transport as a per-delivery
 * deadline. The transport refuses a deadline a timer cannot hold —
 * deliberately, rather than clamping — so figures that push one part past
 * {@link MAX_TIMER_MS} make every part fail before a single byte leaves, with
 * an error written for a programmer and not for the person uploading.
 *
 * The part size is an `ingest:` knob and the other two are `upload:` knobs, so
 * the relation is invisible from inside either section. What is asserted here
 * is that loading the config reaches the rule at all; the rule's own boundary
 * cases live with it, in `@shared/upload/windows`.
 */
describe("storageConfigSchema — the stall guard has to stay expressible", () => {
  /** The shipped part size, and the lowest rate that can still serve it. */
  const SHIPPED_PART = 8388608;
  const LOWEST_USABLE_RATE = Math.ceil((SHIPPED_PART * 1000) / MAX_TIMER_MS);

  /**
   * Pair an upload section with ingest windows wide enough to hold whatever
   * deadline it produces.
   *
   * These cases probe one rule by driving the deadline to extremes, and the
   * other rule — that the idle window outlasts a part's whole delivery — would
   * then be what they trip on. Sized from the same arithmetic that rule uses,
   * so it stays right when either figure moves.
   * @param upload - The upload knobs under test.
   * @returns A whole config for the schema to parse.
   */
  function withRoomToWait(upload: Record<string, number>): Record<string, unknown> {
    const requestTimeoutMs = upload.client_request_timeout_ms ?? 30000;
    const minBytesPerSec = upload.client_put_min_bytes_per_sec ?? 65536;
    const seconds = Math.ceil(
      partRetryBudgetMs(8388608, { requestTimeoutMs, minBytesPerSec }) / 1000,
    );
    const token = Math.max(seconds, Math.ceil(completeRetryBudgetMs() / 1000));
    return {
      upload,
      ingest: { session_token_ttl_seconds: token + 1 },
    };
  }

  it("accepts the lowest rate that still serves one part", () => {
    const cfg = storageConfigSchema.parse(
      withRoomToWait({ client_put_min_bytes_per_sec: LOWEST_USABLE_RATE }),
    );
    expect(cfg.upload.client_put_min_bytes_per_sec).toBe(LOWEST_USABLE_RATE);
    // The property behind the number, so this test still means something if
    // either constant moves.
    expect(
      Math.ceil((cfg.ingest.part_size_bytes / LOWEST_USABLE_RATE) * 1000),
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

  it("moves the floor when the part size moves", () => {
    // The knobs are judged together, not each against a constant, and the one
    // that decides the deadline lives in the other section. Doubling the part
    // doubles what the rate has to be, so a rate that was fine a moment ago is
    // not — which a bound written against the rate alone would let through.
    expect(() =>
      storageConfigSchema.parse({
        upload: { client_put_min_bytes_per_sec: LOWEST_USABLE_RATE },
        ingest: { part_size_bytes: SHIPPED_PART * 2 },
      }),
    ).toThrow(/client_put_min_bytes_per_sec/);
  });

  it("refuses a floor a timer cannot hold either", () => {
    // The deadline is max(floor, part size/rate), so the floor is the second
    // way to produce an unusable figure — and the one a rate-only bound would
    // miss. Enumerated rather than waited for: the invariant is about the
    // deadline, not about one of the two knobs that feed it.
    expect(() =>
      storageConfigSchema.parse({
        upload: { client_request_timeout_ms: MAX_TIMER_MS + 1 },
      }),
    ).toThrow(/client_request_timeout_ms/);

    expect(() =>
      storageConfigSchema.parse(
        withRoomToWait({ client_request_timeout_ms: MAX_TIMER_MS }),
      ),
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
 * `session_token_ttl_seconds` is how long a token stays usable after the part
 * that issued it. One token is carried through a whole part's delivery chain
 * and through the chain completing runs, so it has a floor to clear: a token
 * that expires first turns the delivery that would have succeeded into a 401.
 */
describe("storageConfigSchema — the ingest knobs", () => {
  it("loads the ingest config from config/storage.yaml", () => {
    const cfg = getStorageConfig();
    expect(cfg.ingest.part_size_bytes).toBe(8388608);
    expect(cfg.ingest.ticket_expires_seconds).toBe(300);
    expect(cfg.ingest.session_token_ttl_seconds).toBe(1200);
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

// One session token is carried through a whole part's delivery chain, retries
// included, and through the chain completing runs. A token narrower than
// either turns a delivery on an upload that is doing nothing wrong into a 401.
describe("storageConfigSchema — the windows an upload lives inside", () => {
  it("leaves the shipped figures alone", () => {
    expect(() => storageConfigSchema.parse({})).not.toThrow();
  });

  it("refuses a session token one part's retries can outlast", () => {
    expect(() =>
      storageConfigSchema.parse({
        ingest: { session_token_ttl_seconds: 300 },
      }),
    ).toThrow(/session_token_ttl_seconds/);
  });

  // A bigger part takes longer to deliver, so the token it needs grows with
  // it — the relation is between the two, not a pair of fixed numbers.
  it("moves the token a part needs when the part size moves", () => {
    expect(() =>
      storageConfigSchema.parse({
        ingest: { part_size_bytes: 64 * 1024 * 1024 },
      }),
    ).toThrow(/session_token_ttl_seconds/);
  });
});
