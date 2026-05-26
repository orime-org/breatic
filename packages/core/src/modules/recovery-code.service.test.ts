/**
 * RecoveryCodeService — invariant + property-based test (PR-a task 5).
 *
 * Service contract (recovery-code.service.ts pending impl):
 *   - generateRecoveryCode() → string in format "XXXX-XXXX-XXXX-XXXX"
 *     (RFC 4648 base32, no padding, derived from 16 cryptographically
 *     random bytes; uppercase A-Z + digits 2-7 only)
 *   - hashRecoveryCode(code) → bcrypt hash with cost 12
 *   - verifyRecoveryCode(code, hash) → true if matches, false otherwise
 *
 * Recovery codes are GitHub-style backup codes:
 *   - Displayed once at registration (or after consumption)
 *   - Server stores only bcrypt hash + recovery_code_used_at timestamp
 *   - Single-use: after successful reset, mark used + generate new code
 *
 * This test is RED until `recovery-code.service.ts` is implemented.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-code.service.js";

describe("RecoveryCodeService — generate", () => {
  it("returns string matching XXXX-XXXX-XXXX-XXXX base32 format", () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("returns 19-char string (4×4 + 3 hyphens)", () => {
    const code = generateRecoveryCode();
    expect(code).toHaveLength(19);
  });

  it("returns unique codes across 1000 calls (no collision)", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateRecoveryCode());
    expect(set.size).toBe(1000);
  });
});

describe("RecoveryCodeService — hash + verify (bcrypt cost 12)", () => {
  it("hash() returns bcrypt hash with cost-12 prefix $2[abxy]$12$", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(hash).toMatch(/^\$2[abxy]\$12\$/);
  });

  it("verify(matchingCode, hash) → true", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(code, hash)).toBe(true);
  });

  it("verify(differentCode, hash) → false", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    let wrong = generateRecoveryCode();
    // Guard against (vanishingly unlikely) collision
    while (wrong === code) wrong = generateRecoveryCode();
    expect(await verifyRecoveryCode(wrong, hash)).toBe(false);
  });

  it("verify(lowercaseCode, hash) → false (codes are case-sensitive)", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(code.toLowerCase(), hash)).toBe(false);
  });

  it("verify(codeWithoutHyphens, hash) → false (format must be exact)", async () => {
    const code = generateRecoveryCode();
    const hash = await hashRecoveryCode(code);
    expect(await verifyRecoveryCode(code.replace(/-/g, ""), hash)).toBe(false);
  });
});

describe("RecoveryCodeService — property-based round-trip", () => {
  it(
    "[property] any generated code passes hash + verify round-trip",
    async () => {
      // Bcrypt cost 12 takes ~200ms per op (hash + verify ≈ 400ms);
      // 20 runs × 2 ops ≈ 8s on dev box.
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), async () => {
          const code = generateRecoveryCode();
          const hash = await hashRecoveryCode(code);
          const ok = await verifyRecoveryCode(code, hash);
          return ok === true;
        }),
        { numRuns: 20 },
      );
    },
    30_000,
  );

  it(
    "[property] hash output differs for the same code across calls (bcrypt salt)",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), async () => {
          const code = generateRecoveryCode();
          const h1 = await hashRecoveryCode(code);
          const h2 = await hashRecoveryCode(code);
          return h1 !== h2;
        }),
        { numRuns: 10 },
      );
    },
    30_000,
  );
});
