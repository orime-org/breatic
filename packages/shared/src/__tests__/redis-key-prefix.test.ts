// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Redis key prefix every service resolves the same way (breatic#1488 §13):
 * a blank prefix means "use the environment name", and the prefix may hold
 * only letters, digits, `-` and `_`.
 */

import { describe, it, expect } from "vitest";

import { REDIS_KEY_PREFIX_PATTERN, resolveRedisKeyPrefix } from "@shared/redis-key-prefix.js";

describe("resolveRedisKeyPrefix", () => {
  it("falls back to the environment name when the prefix is missing", () => {
    expect(resolveRedisKeyPrefix(undefined, "dev")).toBe("dev");
    expect(resolveRedisKeyPrefix(undefined, "prod")).toBe("prod");
  });

  it("treats an empty or whitespace-only prefix as missing", () => {
    expect(resolveRedisKeyPrefix("", "dev")).toBe("dev");
    expect(resolveRedisKeyPrefix("   ", "staging")).toBe("staging");
  });

  it("keeps a set prefix, trimmed", () => {
    expect(resolveRedisKeyPrefix("dev-agent", "dev")).toBe("dev-agent");
    expect(resolveRedisKeyPrefix("  dev_b  ", "dev")).toBe("dev_b");
  });
});

describe("REDIS_KEY_PREFIX_PATTERN", () => {
  it("accepts letters, digits, '-' and '_'", () => {
    for (const value of ["dev", "dev-agent", "dev_b", "A1-b_2"]) {
      expect(REDIS_KEY_PREFIX_PATTERN.test(value)).toBe(true);
    }
  });

  it("rejects glob characters, separators and spaces", () => {
    for (const value of ["a*b", "a?b", "a b", "a;b", "a,b", "a:b", ""]) {
      expect(REDIS_KEY_PREFIX_PATTERN.test(value)).toBe(false);
    }
  });
});
