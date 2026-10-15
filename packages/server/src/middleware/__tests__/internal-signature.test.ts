// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Request signing for the internal API (inner#1410 §4.2).
 *
 * The pure half of the signature check: header formats, the ±300 s window
 * and the HMAC itself. The nonce step needs Redis and lives in the
 * middleware (`internal-auth.ts`), after these three.
 *
 * The signed text is exactly seven lines joined by `\n`: method, path with
 * its query string as sent, timestamp, nonce, admin id, the `Idempotency-Key`
 * header (an empty line when absent) and the raw body. The signature header
 * is `v1=` plus the lowercase hex HMAC-SHA256 of that text. Both the current
 * secret and the previous one are accepted, so a rotation does not drop the
 * back office's requests mid-flight.
 *
 * This is the only thing between a caller on the private network and a
 * refund of real money, so the property at the end changes every line in
 * turn and expects each change to be refused.
 */

import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  canonicalString,
  signRequest,
  verifyInternalRequest,
  type SignedParts,
} from "@server/middleware/internal-signature.js";

const SECRET = "current-secret-0123456789abcdef";
const PREVIOUS = "previous-secret-fedcba9876543210";
const SECRETS = { current: SECRET, previous: PREVIOUS };
const NOW = 1_760_000_000;

const PARTS: SignedParts = {
  method: "POST",
  pathWithQuery: "/internal/v1/credit-lots/3f6c/refund/approve?b=2&a=1",
  timestamp: String(NOW),
  nonce: "nonce_0123456789ABCDEF",
  adminId: "admin-7",
  idempotencyKey: "approve-3f6c-1",
  body: '{"reason":"buyer asked","confirmedRefundIds":[]}',
};

const hmacHex = (secret: string, text: string) =>
  createHmac("sha256", secret).update(text, "utf8").digest("hex");

/** The request as the server receives it, built from signed parts and a signature. */
function request(parts: SignedParts, signature: string) {
  const headers: Record<string, string | undefined> = {
    "x-internal-admin": parts.adminId,
    "x-internal-timestamp": parts.timestamp,
    "x-internal-nonce": parts.nonce,
    "x-internal-signature": signature,
  };
  if (parts.idempotencyKey !== null) headers["idempotency-key"] = parts.idempotencyKey;
  return { method: parts.method, pathWithQuery: parts.pathWithQuery, headers, body: parts.body };
}

const signed = (parts: SignedParts, secret = SECRET) => request(parts, signRequest(secret, parts));

const OK = { ok: true, adminId: PARTS.adminId, nonce: PARTS.nonce };
const fail = (step: "headers" | "timestamp" | "signature") => ({ ok: false, step });

describe("canonicalString", () => {
  it("is the seven lines joined by a newline, in order", () => {
    expect(canonicalString(PARTS)).toBe(
      [
        "POST",
        "/internal/v1/credit-lots/3f6c/refund/approve?b=2&a=1",
        "1760000000",
        "nonce_0123456789ABCDEF",
        "admin-7",
        "approve-3f6c-1",
        '{"reason":"buyer asked","confirmedRefundIds":[]}',
      ].join("\n"),
    );
  });

  it("writes an empty sixth line when there is no Idempotency-Key", () => {
    expect(canonicalString({ ...PARTS, method: "GET", idempotencyKey: null, body: "" })).toBe(
      "GET\n/internal/v1/credit-lots/3f6c/refund/approve?b=2&a=1\n1760000000\nnonce_0123456789ABCDEF\nadmin-7\n\n",
    );
  });

  it("keeps the body verbatim, newlines and whitespace included", () => {
    const body = '{\n  "reason": "a\\nb" }\n';
    expect(canonicalString({ ...PARTS, body }).endsWith(`\napprove-3f6c-1\n${body}`)).toBe(true);
  });
});

describe("signRequest", () => {
  it("is v1= plus the lowercase hex HMAC-SHA256 of the canonical string", () => {
    const sig = signRequest(SECRET, PARTS);
    expect(sig).toBe(`v1=${hmacHex(SECRET, canonicalString(PARTS))}`);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});

describe("verifyInternalRequest: keys", () => {
  it("accepts a request signed with the current secret and names the admin and nonce", () => {
    expect(verifyInternalRequest(signed(PARTS), SECRETS, NOW)).toEqual(OK);
  });

  it("accepts a request signed with the previous secret", () => {
    expect(verifyInternalRequest(signed(PARTS, PREVIOUS), SECRETS, NOW)).toEqual(OK);
  });

  it("refuses a request signed with any other secret", () => {
    expect(verifyInternalRequest(signed(PARTS, "someone-else"), SECRETS, NOW)).toEqual(fail("signature"));
  });

  it("refuses the previous secret once it is cleared", () => {
    expect(
      verifyInternalRequest(signed(PARTS, PREVIOUS), { current: SECRET, previous: "" }, NOW),
    ).toEqual(fail("signature"));
  });

  it("does not treat an empty previous secret as a key anyone can sign with", () => {
    expect(verifyInternalRequest(signed(PARTS, ""), { current: SECRET, previous: "" }, NOW)).toEqual(
      fail("signature"),
    );
  });

  // A previous secret of only whitespace (a trailing space in a Docker
  // --env-file, or a space typed to "clear" it) is no key either: anyone could
  // sign with it.
  it.each([" ", "\t", " \n "])("does not treat a whitespace-only previous secret %j as a key", (blank) => {
    expect(verifyInternalRequest(signed(PARTS, blank), { current: SECRET, previous: blank }, NOW)).toEqual(
      fail("signature"),
    );
  });

  it("refuses a signature made without the Idempotency-Key line when the header is sent", () => {
    const sig = signRequest(SECRET, { ...PARTS, idempotencyKey: null });
    expect(verifyInternalRequest(request(PARTS, sig), SECRETS, NOW)).toEqual(fail("signature"));
  });

  it("refuses a signature over an Idempotency-Key the request no longer carries", () => {
    const sig = signRequest(SECRET, PARTS);
    expect(
      verifyInternalRequest(request({ ...PARTS, idempotencyKey: null }, sig), SECRETS, NOW),
    ).toEqual(fail("signature"));
  });
});

describe("verifyInternalRequest: the ±300 second window", () => {
  const at = (offset: number) => ({ ...PARTS, timestamp: String(NOW + offset) });

  it.each([0, 300, -300, 299, -299])("accepts a timestamp %i seconds from now", (offset) => {
    expect(verifyInternalRequest(signed(at(offset)), SECRETS, NOW)).toEqual(OK);
  });

  it.each([301, -301, 3600, -86_400])("refuses a timestamp %i seconds from now", (offset) => {
    expect(verifyInternalRequest(signed(at(offset)), SECRETS, NOW)).toEqual(fail("timestamp"));
  });
});

describe("verifyInternalRequest: header formats", () => {
  const withHeader = (name: string, value: string | undefined) => {
    const req = signed(PARTS);
    return { ...req, headers: { ...req.headers, [name]: value } };
  };

  it.each(["x-internal-admin", "x-internal-timestamp", "x-internal-nonce", "x-internal-signature"])(
    "refuses a request missing %s",
    (name) => {
      expect(verifyInternalRequest(withHeader(name, undefined), SECRETS, NOW)).toEqual(fail("headers"));
    },
  );

  describe("admin id: 1–64 of [A-Za-z0-9_-]", () => {
    it.each(["a", "A".repeat(64), "Az09_-"])("accepts %s", (adminId) => {
      expect(verifyInternalRequest(signed({ ...PARTS, adminId }), SECRETS, NOW)).toEqual({
        ...OK,
        adminId,
      });
    });

    it.each(["", "A".repeat(65), "a.b", "a b", "a/b", "ä", "a\nb"])("refuses %j", (adminId) => {
      expect(verifyInternalRequest(signed({ ...PARTS, adminId }), SECRETS, NOW)).toEqual(fail("headers"));
    });
  });

  describe("nonce: 16–64 of [A-Za-z0-9_-]", () => {
    it.each(["a".repeat(16), "Z".repeat(64), "0123456789_-abcD"])("accepts %s", (nonce) => {
      expect(verifyInternalRequest(signed({ ...PARTS, nonce }), SECRETS, NOW)).toEqual({ ...OK, nonce });
    });

    it.each(["a".repeat(15), "a".repeat(65), "0123456789abcde.", "0123456789 abcdef"])(
      "refuses %j",
      (nonce) => {
        expect(verifyInternalRequest(signed({ ...PARTS, nonce }), SECRETS, NOW)).toEqual(fail("headers"));
      },
    );
  });

  describe("timestamp: unix seconds", () => {
    it.each(["abc", "1760000000.5", "-1760000000", "+1760000000", " 1760000000", "1760000000 ", "", "1e9"])(
      "refuses %j",
      (timestamp) => {
        expect(verifyInternalRequest(signed({ ...PARTS, timestamp }), SECRETS, NOW)).toEqual(
          fail("headers"),
        );
      },
    );
  });

  describe("signature: v1= plus 64 lowercase hex", () => {
    const good = signRequest(SECRET, PARTS);
    const hex = good.slice(3);

    it.each([
      ["uppercase hex", `v1=${hex.toUpperCase()}`],
      ["another version", `v2=${hex}`],
      ["no prefix", hex],
      ["63 hex digits", `v1=${hex.slice(1)}`],
      ["65 hex digits", `v1=${hex}0`],
      ["non-hex digit", `v1=${hex.slice(1)}g`],
      ["a second value appended", `${good},v1=${hex}`],
    ])("refuses %s at the format step", (_label, signature) => {
      expect(verifyInternalRequest(request(PARTS, signature), SECRETS, NOW)).toEqual(fail("headers"));
    });
  });
});

describe("verifyInternalRequest: the order of the checks", () => {
  it("reports a bad header before a stale timestamp", () => {
    const parts = { ...PARTS, nonce: "short", timestamp: String(NOW - 10_000) };
    expect(verifyInternalRequest(signed(parts), SECRETS, NOW)).toEqual(fail("headers"));
  });

  it("reports a stale timestamp before a wrong signature", () => {
    const parts = { ...PARTS, timestamp: String(NOW - 10_000) };
    expect(verifyInternalRequest(signed(parts, "wrong"), SECRETS, NOW)).toEqual(fail("timestamp"));
  });
});

describe("verifyInternalRequest: any one changed line is refused", () => {
  const token = (min: number, max: number) =>
    fc.stringMatching(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`));
  const partsArb: fc.Arbitrary<SignedParts> = fc.record({
    method: fc.constantFrom("GET", "POST"),
    pathWithQuery: fc.constantFrom(
      "/internal/v1/credit-lots/a1/refund",
      "/internal/v1/credit-lots/a1/refund/approve",
      "/internal/v1/refund-operations/o9/mail/resend?x=1",
    ),
    timestamp: fc.constant(String(NOW)),
    nonce: token(16, 64),
    adminId: token(1, 64),
    idempotencyKey: fc.option(token(1, 40), { nil: null }),
    body: fc.string({ maxLength: 200 }),
  });

  /** Change exactly one of the seven lines, keeping every header well-formed and in the window. */
  const tamperArb = fc
    .tuple(partsArb, fc.integer({ min: 0, max: 6 }), token(16, 64), fc.integer({ min: 1, max: 300 }))
    .map(([parts, line, other, shift]): [SignedParts, SignedParts] => {
      const changed = { ...parts };
      switch (line) {
        case 0:
          changed.method = parts.method === "GET" ? "POST" : "GET";
          break;
        case 1:
          changed.pathWithQuery = `${parts.pathWithQuery}x`;
          break;
        case 2:
          changed.timestamp = String(NOW - shift);
          break;
        case 3:
          changed.nonce = other === parts.nonce ? `${other.startsWith("A") ? "B" : "A"}${other.slice(1)}` : other;
          break;
        case 4:
          changed.adminId = parts.adminId === "admin" ? "admim" : "admin";
          break;
        case 5:
          changed.idempotencyKey = parts.idempotencyKey === null ? "k" : null;
          break;
        default:
          changed.body = `${parts.body} `;
      }
      return [parts, changed];
    });

  it("fails at the signature step whichever line changed", () => {
    fc.assert(
      fc.property(tamperArb, ([original, changed]) => {
        expect(canonicalString(changed)).not.toBe(canonicalString(original));
        const sig = signRequest(SECRET, original);
        expect(verifyInternalRequest(request(changed, sig), SECRETS, NOW)).toEqual(fail("signature"));
        // The untouched request still verifies, so the failure is the change's doing.
        expect(verifyInternalRequest(request(original, sig), SECRETS, NOW)).toEqual({
          ok: true,
          adminId: original.adminId,
          nonce: original.nonce,
        });
      }),
      { numRuns: 300 },
    );
  });
});
