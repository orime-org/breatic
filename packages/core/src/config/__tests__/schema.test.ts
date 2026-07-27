// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tests for {@link parseConfig}'s yjs-DB separation invariant: outside
 * dev, `YJS_DATABASE_URL` must point at a DIFFERENT database than
 * `DATABASE_URL` — a same-database misconfig would silently collapse
 * the two-DB split (and corrupt the shared migration ledger), so it
 * must fail fast at init.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_API_PORT, DEFAULT_COLLAB_PORT } from "@breatic/shared";
import { parseConfig } from "@core/config/schema.js";

/**
 * Minimal valid raw env for {@link parseConfig}, overridable per case.
 * @param over - Fields to override on the base env map
 * @returns A raw env map with the required keys populated
 */
function baseEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
    YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic_yjs",
    ...over,
  };
}

describe("parseConfig — yjs DB separation", () => {
  it("rejects YJS_DATABASE_URL == DATABASE_URL (same database) outside dev", () => {
    expect(() =>
      parseConfig(
        baseEnv({
          ENV: "prod",
          YJS_DATABASE_URL: "postgres://breatic:breatic@localhost:5432/breatic",
        }),
      ),
    ).toThrow(/different database/i);
  });

  it("accepts a distinct yjs database outside dev", () => {
    const cfg = parseConfig(baseEnv({ ENV: "prod" }));
    expect(cfg.YJS_DATABASE_URL).toContain("breatic_yjs");
  });

  it("allows the same instance in dev (second db name)", () => {
    expect(() => parseConfig(baseEnv({ ENV: "dev" }))).not.toThrow();
  });

  it("defaults YJS_DATABASE_URL when unset", () => {
    const env = baseEnv();
    delete env["YJS_DATABASE_URL"];
    const cfg = parseConfig(env);
    expect(cfg.YJS_DATABASE_URL).toMatch(/breatic_yjs$/);
  });
});

/**
 * Every numeric env var must treat a blank value as "not set".
 *
 * `.env` files spell "I'm not setting this" as `VAR=`. Zod keeps that as `""`
 * rather than undefined, so `.default()` never fires and `z.coerce.number()`
 * turns `""` into 0 — which fails `.positive()` and refuses to boot. The result
 * is a booby trap: deleting the line works, leaving it blank crashes, and the
 * error ("Too small: expected number to be >0") points nowhere near the cause.
 */
describe("parseConfig — blank numeric vars fall back to their default", () => {
  const NUMERIC_DEFAULTS: ReadonlyArray<readonly [string, number]> = [
    ["PORT", 3000],
    ["SERVER_HEALTH_PORT", 3001],
    ["WORKER_HEALTH_PORT", 9101],
    ["COLLAB_HEALTH_PORT", 1235],
    ["DB_POOL_SIZE", 10],
    ["YJS_DB_POOL_SIZE", 10],
    ["CREDIT_MULTIPLIER", 1.0],
    ["UPLOAD_MAX_IMAGE_MB", 50],
    ["UPLOAD_MAX_VIDEO_MB", 1024],
    ["UPLOAD_MAX_AUDIO_MB", 100],
    ["UPLOAD_MAX_3D_MB", 200],
    ["UPLOAD_MAX_DOCUMENT_MB", 20],
    ["SMTP_PORT", 587],
  ];

  it.each(NUMERIC_DEFAULTS)(
    "%s= (blank) yields its default %d instead of throwing",
    (key, expected) => {
      const cfg = parseConfig(baseEnv({ [key]: "" }));
      expect(cfg[key as keyof typeof cfg]).toBe(expected);
    },
  );

  it.each(NUMERIC_DEFAULTS)(
    "%s with whitespace only yields its default %d",
    (key, expected) => {
      const cfg = parseConfig(baseEnv({ [key]: "  " }));
      expect(cfg[key as keyof typeof cfg]).toBe(expected);
    },
  );

  // Blank means unset; garbage means misconfigured. Only the first one is
  // forgiven — silently booting on a typo'd port would be worse.
  it("still rejects a non-numeric value", () => {
    expect(() => parseConfig(baseEnv({ PORT: "abc" }))).toThrow();
    expect(() => parseConfig(baseEnv({ DB_POOL_SIZE: "ten" }))).toThrow();
  });
});

/**
 * The two ports the vite dev proxy also needs are declared once, in
 * `@breatic/shared`, and read from there by both this schema and
 * `packages/web/dev-ports.mts` (#1831). Asserting against the shared constant
 * rather than a literal is the point: a literal here would still pass while
 * silently disagreeing with what the frontend proxies to.
 */
describe("parseConfig — ports shared with the web build config", () => {
  it("PORT defaults to the shared constant", () => {
    expect(parseConfig(baseEnv()).PORT).toBe(DEFAULT_API_PORT);
  });

  it("COLLAB_PORT defaults to the shared constant", () => {
    expect(parseConfig(baseEnv()).COLLAB_PORT).toBe(DEFAULT_COLLAB_PORT);
  });

  // Guards the numbers themselves: the shared module is what the vite proxy
  // resolves to, so a careless edit there would silently retarget the dev proxy.
  it("the shared constants still hold the documented values", () => {
    expect(DEFAULT_API_PORT).toBe(3000);
    expect(DEFAULT_COLLAB_PORT).toBe(1234);
  });
});

/**
 * `COLLAB_PORT` is the collab WebSocket port. It lives here with the other two
 * service ports rather than in `config/collab.yaml`, where it used to sit —
 * one kind of setting in one place (#1831). Its default comes from
 * `@breatic/shared`, which the vite dev proxy reads too, so there is exactly
 * one declaration of the number.
 */
describe("parseConfig — COLLAB_PORT", () => {
  it("defaults to 1234 when unset", () => {
    expect(parseConfig(baseEnv()).COLLAB_PORT).toBe(1234);
  });

  it("treats a blank value as unset instead of crashing startup", () => {
    expect(parseConfig(baseEnv({ COLLAB_PORT: "" })).COLLAB_PORT).toBe(1234);
    expect(parseConfig(baseEnv({ COLLAB_PORT: "   " })).COLLAB_PORT).toBe(1234);
  });

  it("parses a real port", () => {
    expect(parseConfig(baseEnv({ COLLAB_PORT: "1244" })).COLLAB_PORT).toBe(1244);
  });

  // A garbage value is a genuine misconfiguration — fail loudly at startup
  // rather than silently falling back and binding an unexpected port.
  it("still rejects a non-numeric value", () => {
    expect(() => parseConfig(baseEnv({ COLLAB_PORT: "abc" }))).toThrow();
    expect(() => parseConfig(baseEnv({ COLLAB_PORT: "0" }))).toThrow();
    expect(() => parseConfig(baseEnv({ COLLAB_PORT: "-1" }))).toThrow();
  });
});

/**
 * `REDIS_KEY_PREFIX` namespaces BOTH families of Redis pub/sub channels — the
 * Hocuspocus document-sync channels and the `project:*` control channels — and
 * nothing else. It exists because pub/sub ignores the DB number (SUBSCRIBE is
 * instance-wide), so the `REDIS_*_URL` split isolates every ordinary key but
 * not channels (#1831). Stream keys and stream cursors deliberately stay on
 * `ENV`; see the schema comment for why.
 *
 * The whole point is that it resolves to `ENV` when nobody sets it, so a single
 * deployment and production behave exactly as they did before it existed.
 */
describe("parseConfig — REDIS_KEY_PREFIX", () => {
  it("falls back to ENV when unset", () => {
    expect(parseConfig(baseEnv({ ENV: "dev" })).REDIS_KEY_PREFIX).toBe("dev");
  });

  it("follows ENV rather than a hard-coded 'dev'", () => {
    expect(parseConfig(baseEnv({ ENV: "prod" })).REDIS_KEY_PREFIX).toBe("prod");
  });

  it("uses the explicit value when set", () => {
    expect(
      parseConfig(baseEnv({ REDIS_KEY_PREFIX: "dev-agent" })).REDIS_KEY_PREFIX,
    ).toBe("dev-agent");
  });

  // `.env` templates spell optional vars as `VAR=` (blank), and zod keeps
  // "" rather than treating it as undefined. A blank prefix would silently
  // produce channels named ":hocuspocus:..." — isolated from nobody in
  // particular. Blank must mean "unset".
  it("treats a blank value as unset", () => {
    expect(
      parseConfig(baseEnv({ ENV: "dev", REDIS_KEY_PREFIX: "" })).REDIS_KEY_PREFIX,
    ).toBe("dev");
    expect(
      parseConfig(baseEnv({ ENV: "dev", REDIS_KEY_PREFIX: "   " }))
        .REDIS_KEY_PREFIX,
    ).toBe("dev");
  });

  // The prefix is interpolated into a PSUBSCRIBE glob by the subscriber and
  // used literally by the publishers. A prefix carrying glob metacharacters
  // therefore means the two sides stop agreeing: `a*b` as a pattern matches
  // channels no publisher writes, and misses the ones it does. It also lands in
  // the session cookie name, where only token characters are legal. Reject the
  // whole class at config time rather than debugging a silent mismatch later.
  it.each(["a*b", "a?b", "a[b]", "a:b", "a b", "a;b", "a,b"])(
    "rejects %s — glob metacharacters and cookie-illegal characters",
    (value) => {
      expect(() => parseConfig(baseEnv({ REDIS_KEY_PREFIX: value }))).toThrow();
    },
  );

  it.each(["dev", "dev-agent", "dev_agent", "staging2"])(
    "accepts %s",
    (value) => {
      expect(
        parseConfig(baseEnv({ REDIS_KEY_PREFIX: value })).REDIS_KEY_PREFIX,
      ).toBe(value);
    },
  );

  it("trims surrounding whitespace on an explicit value", () => {
    expect(
      parseConfig(baseEnv({ REDIS_KEY_PREFIX: "  dev-agent  " }))
        .REDIS_KEY_PREFIX,
    ).toBe("dev-agent");
  });
});
