// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Unit tests for `getCollabConfig`.
 *
 * This loader is behaviour knobs only. The WebSocket port used to live in
 * `config/collab.yaml` as a plain key with a schema default — no env var read
 * it, which made it the one service port unsettable from `.env` while the
 * other three already sat in the core env schema. It moved there too (#1831),
 * and what these tests guard is that it STAYS moved: a `port:` reappearing in
 * the YAML would silently be ignored (the schema strips unknown keys), leaving
 * whoever set it convinced they configured something.
 *
 * The YAML is read for real — stubbing the loader would make these vacuous.
 */
import type * as FsModule from "node:fs";
import type * as ConfigModule from "../config.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";

async function loadConfig() {
  vi.resetModules();
  const mod = await import("../config.js");
  return mod.getCollabConfig();
}

describe("getCollabConfig", () => {
  it("loads the behaviour knobs from the YAML", async () => {
    const cfg = await loadConfig();

    expect(cfg.debounce).toBeGreaterThan(0);
    expect(cfg.max_debounce).toBeGreaterThanOrEqual(cfg.debounce);
    expect(typeof cfg.quiet).toBe("boolean");
    expect(typeof cfg.unload_immediately).toBe("boolean");
  });

  // The port belongs to the core env schema now. Someone putting `port:` back
  // into collab.yaml gets a silent no-op: zod's default unknown-key stripping
  // drops it and the service keeps listening on COLLAB_PORT, while whoever
  // edited the YAML believes they configured something.
  //
  // Assert on the YAML TEXT, not on the parsed object. Asserting the parsed
  // config has no `port` property is vacuous — stripping guarantees it whether
  // or not the key is in the file. (Verified: adding `port: 9999` to the YAML
  // left that assertion green.)
  it("collab.yaml declares no port — that setting lives in the core env schema", () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, "../../../../config/collab.yaml"),
      "utf-8",
    );

    expect(yaml).not.toMatch(/^\s*port\s*:/m);
  });

  it("returns the same frozen object on repeat calls", async () => {
    vi.resetModules();
    const mod = await import("../config.js");

    const first = mod.getCollabConfig();
    const second = mod.getCollabConfig();

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("the store's knobs", () => {
  // Storing is not on a clock: an attempt runs until the write answers, and
  // the answer is the whole outcome. The two timeouts that used to be here —
  // one per attempt, one over the shutdown phase — cancelled nothing and only
  // manufactured a third outcome to report. What is left is the interval,
  // which is a write-load knob.

  it("declares how often the loop runs", async () => {
    const cfg = await loadConfig();

    expect(cfg.store_interval_ms).toBeGreaterThan(0);
  });

  // Same trap as `port` above, and Gate 2 round 5 caught this block falling
  // into it: the first version asserted the PARSED config has no
  // `store_final_attempt_timeout_ms`, which zod's stripping guarantees whether
  // or not the key is in the file. (Verified: putting both keys back into the
  // YAML left that assertion green.) Someone reading an old runbook or the
  // pre-removal git history and re-adding either key would get a silent no-op.
  it("collab.yaml declares no deadline over a store — waiting is the whole point", () => {
    const yaml = readFileSync(
      resolve(import.meta.dirname, "../../../../config/collab.yaml"),
      "utf-8",
    );

    expect(yaml).not.toMatch(/^\s*store_final_attempt_timeout_ms\s*:/m);
    expect(yaml).not.toMatch(/^\s*store_shutdown_settle_budget_ms\s*:/m);
  });
});

describe("the knobs of several collab instances (inner#1497)", () => {
  it("reads every event-consumer and unload-retry knob from the YAML", async () => {
    const yaml = readFileSync(resolve(import.meta.dirname, "../../../../config/collab.yaml"), "utf-8");
    for (const key of [
      "event_max_held",
      "event_block_ms",
      "event_doc_concurrency",
      "event_doc_lease_ms",
      "event_lease_retry_ms",
      "event_handoff_poll_ms",
      "event_handoff_wait_ms",
      "event_claim_interval_ms",
      "event_claim_idle_ms",
      "event_retry_min_ms",
      "event_retry_max_ms",
      "event_max_failures",
      "event_stop_deadline_ms",
      "event_forget_idle_consumer_ms",
      "unload_store_retry_ms",
      "unload_store_retry_interval_ms",
      "unload_rescue_reserve_ms",
    ]) {
      expect(yaml).toMatch(new RegExp(`^${key}\\s*:`, "m"));
    }
  });

  it("keeps the values consistent with one another", async () => {
    const cfg = await loadConfig();

    // A waiting entry is taken over only once its holder is clearly gone.
    expect(cfg.event_claim_idle_ms).toBeGreaterThan(cfg.event_doc_lease_ms);
    // Redlock refuses a lease shorter than its extension threshold plus 100ms.
    expect(cfg.event_doc_lease_ms).toBeGreaterThan(600);
    expect(cfg.event_retry_max_ms).toBeGreaterThanOrEqual(cfg.event_retry_min_ms);
    expect(cfg.event_handoff_wait_ms).toBeGreaterThan(cfg.event_handoff_poll_ms);
    // A peer's store lock lasts one second and is not extended.
    expect(cfg.unload_store_retry_ms).toBeGreaterThan(1000);
    expect(cfg.unload_store_retry_ms).toBeGreaterThan(cfg.unload_store_retry_interval_ms);
  });
});

describe("the session recheck interval", () => {
  // A timer quietly turns a delay above MAX_TIMER_MS into one millisecond,
  // which would read every session on every tick (inner#1548).
  it("refuses an interval no timer can hold, when the config loads", async () => {
    const { MAX_TIMER_MS } = await import("@breatic/shared");
    const real = readFileSync(resolve(import.meta.dirname, "../../../../config/collab.yaml"), "utf-8");
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => ({
      ...(await orig<typeof FsModule>()),
      readFileSync: () =>
        real.replace(/^session_recheck_interval_ms:.*$/m, `session_recheck_interval_ms: ${MAX_TIMER_MS + 1}`),
    }));
    try {
      const mod = await import("../config.js");
      expect(() => mod.getCollabConfig()).toThrow(/session_recheck_interval_ms[\s\S]*too_big|too_big[\s\S]*session_recheck_interval_ms/);
    } finally {
      vi.doUnmock("node:fs");
    }
  });
});

describe("the document size knobs (inner#1790)", () => {
  const YAML_PATH = resolve(import.meta.dirname, "../../../../config/collab.yaml");
  const REAL = readFileSync(YAML_PATH, "utf-8");

  /** The short names the spec uses, mapped to the YAML keys. */
  const KEY = {
    max: "max_document_bytes",
    ratio: "document_size_warn_ratio",
    margin: "document_size_full_margin_bytes",
    headroom: "document_size_delete_headroom_bytes",
    reserve: "document_size_overwrite_reserve_bytes",
    interval: "document_size_measure_interval_ms",
    trials: "document_size_trials_per_user_per_minute",
    budget: "document_size_trial_budget_ms_per_second",
  } as const;

  /**
   * The repository YAML with some keys replaced, or appended when absent.
   * @param values - YAML key to value.
   * @returns The YAML text.
   */
  function yamlWith(values: Record<string, number>): string {
    let text = REAL;
    for (const [key, value] of Object.entries(values)) {
      const line = new RegExp(`^${key}\\s*:.*$`, "m");
      text = line.test(text) ? text.replace(line, `${key}: ${value}`) : `${text}\n${key}: ${value}\n`;
    }
    return text;
  }

  /**
   * Import a fresh config module that reads the given YAML text.
   * @param text - Returns the YAML text on each read.
   * @returns The module.
   */
  async function freshModule(text: () => string): Promise<typeof ConfigModule> {
    vi.resetModules();
    vi.doMock("node:fs", async (orig) => ({
      ...(await orig<typeof FsModule>()),
      readFileSync: () => text(),
    }));
    return import("../config.js");
  }

  /**
   * Load the config with some keys overridden; must not throw.
   * @param values - YAML key to value.
   * @returns The parsed config.
   */
  async function accepted(values: Record<string, number>): Promise<Record<string, unknown>> {
    try {
      const mod = await freshModule(() => yamlWith(values));
      const cfg = mod.getCollabConfig() as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(values)) {
        expect(cfg[key], `${JSON.stringify(values)} reads back ${key}`).toBe(value);
      }
      return cfg;
    } finally {
      vi.doUnmock("node:fs");
    }
  }

  /**
   * Load the config with some keys overridden; the first `getCollabConfig()`
   * must throw a zod error (or an error wrapping one) naming `key`. Importing the module must not throw:
   * the check runs when the config is first read at startup (C-19).
   * @param values - YAML key to value.
   * @param key - The key the issue path must name.
   * @param exactPath - Whether the issue path must be exactly `[key]`.
   * @returns Nothing.
   */
  async function refused(values: Record<string, number>, key: string, exactPath = false): Promise<void> {
    try {
      const mod = await freshModule(() => yamlWith(values));
      let thrown: unknown;
      try {
        mod.getCollabConfig();
      } catch (err) {
        thrown = err;
      }
      const label = JSON.stringify(values);
      expect(thrown, `${label} must be refused`).toBeInstanceOf(Error);
      // A ZodError, or an error wrapping one as its cause.
      type WithIssues = { issues?: { path: (string | number)[] }[]; cause?: { issues?: { path: (string | number)[] }[] } };
      const issues = (thrown as WithIssues).issues ?? (thrown as WithIssues).cause?.issues ?? [];
      expect(issues.length, `${label} carries zod issues`).toBeGreaterThan(0);
      if (exactPath) {
        expect(issues.some((issue) => issue.path.length === 1 && issue.path[0] === key), label).toBe(true);
      } else {
        expect(issues.some((issue) => issue.path.includes(key)), label).toBe(true);
      }
    } finally {
      vi.doUnmock("node:fs");
    }
  }

  it("C-10 declares all seven keys in collab.yaml and ships the agreed defaults", async () => {
    for (const key of [KEY.ratio, KEY.margin, KEY.headroom, KEY.reserve, KEY.interval, KEY.trials, KEY.budget]) {
      expect(REAL).toMatch(new RegExp(`^\\s*${key}\\s*:`, "m"));
    }
    const cfg = (await loadConfig()) as unknown as Record<string, unknown>;
    expect(cfg[KEY.ratio]).toBe(0.8);
    expect(cfg[KEY.margin]).toBe(262144);
    expect(cfg[KEY.headroom]).toBe(262144);
    expect(cfg[KEY.reserve]).toBe(65536);
    expect(cfg[KEY.interval]).toBe(2000);
    expect(cfg[KEY.trials]).toBe(6);
    expect(cfg[KEY.budget]).toBe(200);
    expect(cfg[KEY.max]).toBe(10485760);
  });

  // C-19 is asserted by `refused` itself: the module imports, the first read throws.
  it("C-11 C-19 keeps the warning ratio strictly between 0 and 1", async () => {
    for (const bad of [0, 1, -0.1, 1.2]) await refused({ [KEY.ratio]: bad }, KEY.ratio);
    for (const good of [0.5, 0.0001]) await accepted({ [KEY.ratio]: good });
    // 0.999 passes the cross check only with a margin below 10485760 × 0.001.
    await accepted({ [KEY.ratio]: 0.999, [KEY.margin]: 10000 });
  });

  it("C-12 C-19 keeps the full margin above 0, below the limit and below the gap left by the ratio", async () => {
    for (const bad of [0, 10485760, 10485761]) await refused({ [KEY.margin]: bad }, KEY.margin);
    // 10485760 × 0.8 = 8388608 = 10485760 − 2097152: the equality point is refused.
    await refused({ [KEY.ratio]: 0.8, [KEY.margin]: 2097152 }, KEY.margin);
    await accepted({ [KEY.ratio]: 0.8, [KEY.margin]: 2097151 });
    await accepted({ [KEY.margin]: 1 });
  });

  it("C-13 C-19 keeps the delete headroom above 0", async () => {
    for (const bad of [0, -1]) await refused({ [KEY.headroom]: bad }, KEY.headroom);
    // The overwrite reserve must stay below the headroom, so lower it with it.
    await accepted({ [KEY.headroom]: 1, [KEY.reserve]: 0 });
  });

  it("C-14 C-19 keeps the overwrite reserve at 0 or above and below the delete headroom", async () => {
    for (const good of [0, 262143]) await accepted({ [KEY.headroom]: 262144, [KEY.reserve]: good });
    for (const bad of [262144, -1]) await refused({ [KEY.headroom]: 262144, [KEY.reserve]: bad }, KEY.reserve);
    await accepted({ [KEY.headroom]: 1000, [KEY.reserve]: 999 });
    await refused({ [KEY.headroom]: 1000, [KEY.reserve]: 1000 }, KEY.reserve);
  });

  it("C-15 C-19 keeps the measure interval between 1 and MAX_TIMER_MS", async () => {
    await refused({ [KEY.interval]: 0 }, KEY.interval);
    await accepted({ [KEY.interval]: 1 });
    await accepted({ [KEY.interval]: 2147483647 });
    await refused({ [KEY.interval]: 2147483648 }, KEY.interval);
  });

  it("C-16 C-19 needs at least one trial per user per minute", async () => {
    await refused({ [KEY.trials]: 0 }, KEY.trials);
    await accepted({ [KEY.trials]: 1 });
  });

  it("C-17 C-19 keeps the trial budget between 1 and 1000 ms per second", async () => {
    await refused({ [KEY.budget]: 0 }, KEY.budget);
    await accepted({ [KEY.budget]: 1 });
    await accepted({ [KEY.budget]: 1000 });
    await refused({ [KEY.budget]: 1001 }, KEY.budget);
  });

  it("C-18 skips the cross-key checks when the limit is 0", async () => {
    const plain = await accepted({ [KEY.max]: 0 });
    expect(plain[KEY.max]).toBe(0);
    expect(plain[KEY.margin]).toBe(262144);
    const impossible = await accepted({ [KEY.max]: 0, [KEY.margin]: 5000000, [KEY.ratio]: 0.99 });
    expect(impossible[KEY.max]).toBe(0);
  });

  it("C-20 keeps deriving the reassembly cap from the document limit", async () => {
    vi.resetModules();
    const repo = await import("../config.js");
    expect(repo.getReassemblyLimits().maxMessageBytes).toBe(10485760 + 65536);
    try {
      const scaled = await freshModule(() => yamlWith({
        [KEY.max]: 1048576,
        [KEY.ratio]: 0.8,
        [KEY.margin]: 26214,
        [KEY.headroom]: 26214,
        [KEY.reserve]: 6554,
        [KEY.interval]: 2000,
        [KEY.trials]: 6,
        [KEY.budget]: 200,
      }));
      expect(scaled.getReassemblyLimits().maxMessageBytes).toBe(1114112);
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("C-21 reads the YAML once: a later edit does not change the running config", async () => {
    let text = REAL;
    try {
      const mod = await freshModule(() => text);
      const first = mod.getCollabConfig();
      const firstMax = first.max_document_bytes;
      text = yamlWith({ [KEY.max]: 0 });
      const second = mod.getCollabConfig();
      expect(second).toBe(first);
      expect(Object.isFrozen(second)).toBe(true);
      expect(second.max_document_bytes).toBe(firstMax);
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("C-22 requires whole numbers for bytes, milliseconds and counts, not for the ratio", async () => {
    for (const key of [KEY.margin, KEY.headroom, KEY.reserve, KEY.interval, KEY.trials, KEY.budget]) {
      await refused({ [key]: 1.5 }, key);
    }
    await refused({ [KEY.reserve]: 0.5 }, KEY.reserve);
    await accepted({ [KEY.ratio]: 0.75 });
  });

  it("C-23 still checks each key's own range when the limit is 0", async () => {
    const cases: [string, number][] = [
      [KEY.ratio, 1.5],
      [KEY.budget, 1001],
      [KEY.interval, 0],
      [KEY.headroom, 0],
      [KEY.trials, 0],
      [KEY.reserve, -1],
    ];
    for (const [key, bad] of cases) await refused({ [KEY.max]: 0, [key]: bad }, key, true);
  });
});
