// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
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
    // Durations that are whole days without being a deferred decision opt out
    // in the open, on the line itself.
    {
      code: "const EMAIL_VERIFY_TTL = 24 * 3600; // request-ttl:allow — email verification, not a deferred decision",
    },
    {
      code: "const ms = 86400000; // request-ttl:allow — cache horizon",
    },
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
    {
      // Neither does spelling an hour as one number. Matching the SHAPE of the
      // arithmetic only ever catches the shapes somebody thought of; what
      // makes this a day is the value it comes to.
      code: "const at = new Date(Date.now() + 7 * 24 * 3600 * 1000);",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      code: "const seconds = 7 * 24 * 3600;",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      code: "const ms = 7 * 86400000;",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      // Nor does skipping the arithmetic altogether.
      code: "const at = new Date(Date.now() + 604800000);",
      errors: [{ messageId: "ttlArithmetic" }],
    },
    {
      code: "const seconds = 86400;",
      errors: [{ messageId: "ttlArithmetic" }],
    },
  ],
});
