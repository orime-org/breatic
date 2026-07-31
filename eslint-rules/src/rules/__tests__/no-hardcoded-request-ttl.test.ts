// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noHardcodedRequestTtl } from "../no-hardcoded-request-ttl";

const ruleTester = new RuleTester();

ruleTester.run("no-hardcoded-request-ttl", noHardcodedRequestTtl, {
  valid: [
    // The one blessed way to stamp an expiry.
    { code: "const expiresAt = deferredRequestExpiry();" },
    { code: "await redis.set(key, id, 'EX', deferredRequestTtlSeconds());" },
    // Multiplication that is not a day spelled out.
    { code: "const ms = seconds * 1000;" },
    { code: "const area = 24 * 60;" },
    // A name that merely contains TTL is not a per-flow day count.
    { code: "const TTL_SECONDS = fromConfig();" },
  ],
  invalid: [
    {
      // The constant four flows each used to carry.
      code: "const INVITE_TTL_DAYS = 7;",
      errors: [{ messageId: "ttlConstant" }],
    },
    {
      code: "const TRANSFER_TTL_DAYS = 7;\nconst x = TRANSFER_TTL_DAYS * 2;",
      errors: [{ messageId: "ttlConstant" }, { messageId: "ttlConstant" }],
    },
    {
      // The arithmetic, in milliseconds — reported once for the whole chain,
      // not once per nested `*`.
      code: "const at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      // And in seconds, for the Redis token TTLs.
      code: "const seconds = 7 * 24 * 60 * 60;",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      // Order does not save it.
      code: "const ms = 1000 * 60 * 60 * 24;",
      errors: [{ messageId: "ttlArithmetic" }],
    },
  ],
});
