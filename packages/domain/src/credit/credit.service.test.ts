/**
 * Credit service regex/validation tests.
 *
 * The full `deductOnce` function depends on Redis + Postgres, which
 * live under integration tests. Here we exercise only the pure
 * `REFKEY_PATTERN` contract so unit-test runs stay docker-free.
 */

import { describe, it, expect } from "vitest";
import { REFKEY_PATTERN } from "./credit.service.js";

describe("REFKEY_PATTERN", () => {
  // BUG-047 — values that must be rejected
  const invalid: Array<[string, string]> = [
    ["empty string", ""],
    ["single space", " "],
    ["whitespace only", "   "],
    ["embedded space", "task 123"],
    ["forward slash", "foo/bar"],
    ["null byte", "foo\0bar"],
    ["newline", "foo\nbar"],
    ["unicode", "任务-123"],
    ["length 256", "a".repeat(256)],
  ];
  for (const [label, value] of invalid) {
    it(`rejects ${label}`, () => {
      expect(REFKEY_PATTERN.test(value)).toBe(false);
    });
  }

  // Values that must be accepted — matches real call-site patterns.
  const valid: Array<[string, string]> = [
    ["UUID v4", "550e8400-e29b-41d4-a716-446655440000"],
    ["turn composite", "conv-abc-turn-5"],
    ["spawn composite", "task-abc:spawn:3"],
    ["all punctuation chars", "A_b.c-d:e"],
    ["single char", "a"],
    ["length 255", "a".repeat(255)],
  ];
  for (const [label, value] of valid) {
    it(`accepts ${label}`, () => {
      expect(REFKEY_PATTERN.test(value)).toBe(true);
    });
  }
});
