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
import { parse } from "yaml";
import { S, S_CONFIG } from "./helpers/document-size-fixtures.js";

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

describe("the document size knobs (inner#1790, second version)", () => {
  const YAML_PATH = resolve(import.meta.dirname, "../../../../config/collab.yaml");
  const REAL = readFileSync(YAML_PATH, "utf-8");

  /** The short names the v2 test spec uses, mapped to the YAML keys. */
  const KEY = {
    max: "max_document_bytes",
    ratio: "document_size_warn_ratio",
    headroom: "document_size_delete_headroom_bytes",
    splits: "document_size_max_delete_splits",
    interval: "document_size_measure_interval_ms",
  } as const;

  /** The first version's keys the second removes (design 6). */
  const REMOVED = [
    "document_size_full_margin_bytes",
    "document_size_overwrite_reserve_bytes",
    "document_size_trials_per_user_per_minute",
    "document_size_trial_budget_ms_per_second",
  ] as const;

  /**
   * The repository YAML with some keys replaced, or appended when absent.
   * @param values - YAML key to value.
   * @param base - The YAML text to start from.
   * @returns The YAML text.
   */
  function yamlWith(values: Record<string, number>, base: string = REAL): string {
    let text = base;
    for (const [key, value] of Object.entries(values)) {
      const line = new RegExp(`^${key}\\s*:.*$`, "m");
      text = line.test(text) ? text.replace(line, `${key}: ${value}`) : `${text}\n${key}: ${value}\n`;
    }
    return text;
  }

  /**
   * The repository YAML with some keys' lines removed.
   * @param keys - The YAML keys to drop.
   * @returns The YAML text.
   */
  function yamlWithout(keys: readonly string[]): string {
    let text = REAL;
    for (const key of keys) text = text.replace(new RegExp(`^${key}\\s*:.*\\n?`, "m"), "");
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
   * Load the config from a YAML text; must not throw.
   * @param text - The YAML text.
   * @returns The parsed config.
   */
  async function parsedFrom(text: string): Promise<Record<string, unknown>> {
    try {
      const mod = await freshModule(() => text);
      return mod.getCollabConfig();
    } finally {
      vi.doUnmock("node:fs");
    }
  }

  /**
   * Load the config with some keys overridden; must not throw, and each key
   * reads back the value written.
   * @param values - YAML key to value.
   * @returns The parsed config.
   */
  async function accepted(values: Record<string, number>): Promise<Record<string, unknown>> {
    const cfg = await parsedFrom(yamlWith(values));
    for (const [key, value] of Object.entries(values)) {
      expect(cfg[key], `${JSON.stringify(values)} reads back ${key}`).toBe(value);
    }
    return cfg;
  }

  /**
   * Load the config with some keys overridden; the first `getCollabConfig()`
   * must throw a zod error (or an error wrapping one) whose issue path is
   * exactly `[key]`. Importing the module must not throw: the check runs when
   * the config is first read at startup.
   * @param values - YAML key to value.
   * @param key - The key the issue path must name.
   * @returns Nothing.
   */
  async function refused(values: Record<string, number>, key: string): Promise<void> {
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
      type WithIssues = { issues?: { path: (string | number)[] }[]; cause?: { issues?: { path: (string | number)[] }[] } };
      const issues = (thrown as WithIssues).issues ?? (thrown as WithIssues).cause?.issues ?? [];
      expect(issues.some((issue) => issue.path.length === 1 && issue.path[0] === key), label).toBe(true);
    } finally {
      vi.doUnmock("node:fs");
    }
  }

  it("CF-01 collab.yaml ships the agreed values and the loader reads them", async () => {
    const parsed = parse(REAL) as Record<string, unknown>;
    const expected: Record<string, number> = {
      [KEY.max]: 10_485_760,
      [KEY.ratio]: 0.9,
      [KEY.headroom]: 262_144,
      [KEY.splits]: 1024,
      [KEY.interval]: 2000,
    };
    const cfg = (await loadConfig()) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(parsed[key], `${key} in the file`).toBe(value);
      expect(cfg[key], `${key} as loaded`).toBe(value);
    }
  });

  it("CF-02 the four document_size_* keys default to the same values when the YAML leaves them out", async () => {
    const text = yamlWithout([KEY.ratio, KEY.headroom, KEY.splits, KEY.interval]);
    expect(text).not.toMatch(/^document_size_/m);
    const cfg = await parsedFrom(text);
    expect(cfg[KEY.ratio]).toBe(0.9);
    expect(cfg[KEY.headroom]).toBe(262_144);
    expect(cfg[KEY.splits]).toBe(1024);
    expect(cfg[KEY.interval]).toBe(2000);
  });

  it("CF-03 keeps the warning ratio strictly between 0 and 1", async () => {
    for (const bad of [0, 1, 1.2, -0.1]) await refused({ [KEY.ratio]: bad }, KEY.ratio);
    for (const good of [0.5, 0.99]) await accepted({ [KEY.ratio]: good });
  });

  it("CF-04 keeps the delete headroom a whole number above 0", async () => {
    for (const bad of [0, -1, 1.5]) await refused({ [KEY.headroom]: bad }, KEY.headroom);
    await accepted({ [KEY.headroom]: 1 });
  });

  it("CF-05 keeps the delete split cap a whole number of at least 1", async () => {
    for (const bad of [0, 2.5]) await refused({ [KEY.splits]: bad }, KEY.splits);
    await accepted({ [KEY.splits]: 1 });
  });

  it("CF-06 keeps the measure interval a whole number between 1 and MAX_TIMER_MS", async () => {
    for (const bad of [0, 2_147_483_648, 10.5]) await refused({ [KEY.interval]: bad }, KEY.interval);
    for (const good of [1, 2_147_483_647]) await accepted({ [KEY.interval]: good });
  });

  // Answer Q5: with the limit 0 each key is still checked against its own range.
  it("CF-07 accepts a limit of 0 with the other keys at their defaults, and still checks each key's range", async () => {
    const cfg = await accepted({ [KEY.max]: 0 });
    expect(cfg[KEY.ratio]).toBe(0.9);
    expect(cfg[KEY.headroom]).toBe(262_144);
    expect(cfg[KEY.splits]).toBe(1024);
    expect(cfg[KEY.interval]).toBe(2000);
    const bad: Array<[string, number]> = [
      [KEY.ratio, 1.5],
      [KEY.headroom, 0],
      [KEY.splits, 0],
      [KEY.interval, 0],
    ];
    for (const [key, value] of bad) await refused({ [KEY.max]: 0, [key]: value }, key);
  });

  it("CF-08 neither the parsed config nor collab.yaml carries the first version's four keys", async () => {
    const cfg = (await loadConfig()) as unknown as Record<string, unknown>;
    for (const key of REMOVED) {
      expect(cfg, key).not.toHaveProperty(key);
      expect(REAL, key).not.toMatch(new RegExp(`^\\s*${key}\\s*:`, "m"));
    }
  });

  it("CF-09 accepts configuration S", async () => {
    await accepted({ ...S_CONFIG });
  });

  it("keeps deriving the largest message from the document limit", async () => {
    vi.resetModules();
    const repo = await import("../config.js");
    expect(repo.getReassemblyLimits().maxMessageBytes).toBe(10_485_760 + 65_536);
    try {
      const scaled = await freshModule(() => yamlWith({ ...S_CONFIG }));
      expect(scaled.getReassemblyLimits().maxMessageBytes).toBe(S.MESSAGE);
    } finally {
      vi.doUnmock("node:fs");
    }
  });

  it("reads the YAML once: a later edit does not change the running config", async () => {
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
});
