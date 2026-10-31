// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { ReplyError } from "ioredis";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { redactSessionError } from "@core/infra/session-error.js";

/** The diagnostic fields allowed to leave the session IO boundary. */
type SessionError = Error & {
  code?: string | number;
  sourceType?: string;
  cause?: unknown;
};

/**
 * Exercise the Error serializer used by the application logger.
 * @throws {TypeError} When the error cannot be serialized.
 */
function serialized(error: Error): string {
  return JSON.stringify(pino.stdSerializers.err(error));
}

/**
 * Assert the field whitelist recursively on the public Error value.
 * @throws {Error} When a diagnostic value contains a field outside the whitelist.
 */
function expectWhitelisted(error: Error): void {
  const allowed = new Set(["message", "stack", "name", "code", "sourceType", "cause"]);
  expect(Object.getOwnPropertyNames(error).filter((key) => !allowed.has(key))).toEqual([]);
  const cause: unknown = error.cause;
  if (cause instanceof Error) expectWhitelisted(cause);
}

/**
 * Construct the installed driver's actual server-reply error type.
 * @throws {Error} When the driver cannot construct its reply error.
 */
function replyError(message: string): Error {
  const Constructor = ReplyError as new (message: string) => Error;
  return new Constructor(message);
}

describe("redactSessionError", () => {
  it("keeps safe diagnostics and removes credentials and command arguments", () => {
    const token = "secret/session?token=one";
    const encoded = encodeURIComponent(token);
    const original = Object.assign(replyError(`WRONGTYPE diagnostic ${token} ${encoded}`), {
      code: `REDIS_${token}`,
      command: { name: "get", args: [`dev:session:${token}`] },
      vendorPayload: { token },
    });
    original.stack = `ReplyError: diagnostic ${token}\n at GET ${encoded}`;

    const safe = redactSessionError(original, [token]) as SessionError;
    const wire = JSON.parse(serialized(safe)) as Record<string, unknown>;

    expect(safe).toBeInstanceOf(Error);
    expect(safe).not.toBe(original);
    expect(safe.message).toBe("WRONGTYPE diagnostic [Redacted] [Redacted]");
    expect(safe.name).toBe("ReplyError");
    expect(safe.stack).toBe("ReplyError: diagnostic [Redacted]\n at GET [Redacted]");
    expect(safe.code).toBe("REDIS_[Redacted]");
    expect(safe.sourceType).toBe("ReplyError");
    expect(wire.type).toBe("Error");
    expect(wire).not.toHaveProperty("command");
    expect(wire).not.toHaveProperty("vendorPayload");
    expect(serialized(safe)).not.toContain(token);
    expect(serialized(safe)).not.toContain(encoded);
    expectWhitelisted(safe);
    expect(original.command).toEqual({ name: "get", args: [`dev:session:${token}`] });
    expect(original.message).toBe(`WRONGTYPE diagnostic ${token} ${encoded}`);
    expect(original.stack).toBe(`ReplyError: diagnostic ${token}\n at GET ${encoded}`);
  });

  it("sanitizes a writable Error name containing a credential", () => {
    const original = new Error("SAFE_DIAGNOSTIC");
    original.name = "VendorError secret-token";

    const safe = redactSessionError(original, ["secret-token"]) as SessionError;

    expect(safe.name).toBe("VendorError [Redacted]");
    expect(safe.sourceType).toBe("Error");
    expect(safe.message).toBe("SAFE_DIAGNOSTIC");
    expect(serialized(safe)).not.toContain("secret-token");
    expect(original.name).toBe("VendorError secret-token");
    expectWhitelisted(safe);
  });

  it.each([503, "ECONNRESET"])("preserves the diagnostic code %s", (code) => {
    const safe = redactSessionError(Object.assign(new Error("Connection is closed."), { code }), []) as SessionError;

    expect(safe.code).toBe(code);
    expect(typeof safe.code).toBe(typeof code);
    expect(safe.message).toBe("Connection is closed.");
    expect(safe.sourceType).toBe("Error");
    expectWhitelisted(safe);
  });

  it.each([true, { private: "secret-token" }, null])("omits unsupported code value %j", (code) => {
    const safe = redactSessionError(Object.assign(new Error("diagnostic"), { code }), ["secret-token"]) as SessionError;

    expect(safe.code).toBeUndefined();
    expect(safe.message).toBe("diagnostic");
    expectWhitelisted(safe);
  });

  it("keeps ordinary diagnostics when a code or secret list is absent", () => {
    const original = new Error("Command timed out");
    original.stack = "Error: Command timed out\n at session lookup";

    const safe = redactSessionError(original, []) as SessionError;

    expect(safe.message).toBe("Command timed out");
    expect(safe.stack).toBe(original.stack);
    expect(safe.name).toBe("Error");
    expect(safe.code).toBeUndefined();
    expect(safe.sourceType).toBe("Error");
    expectWhitelisted(safe);
  });

  it("sanitizes an Error whose optional stack is absent", () => {
    const original = new Error("SAFE_DIAGNOSTIC secret-token");
    delete original.stack;

    const safe = redactSessionError(original, ["secret-token"]);

    expect(safe.message).toBe("SAFE_DIAGNOSTIC [Redacted]");
    expect(safe.name).toBe("Error");
    expect(serialized(safe)).not.toContain("secret-token");
    expect(Object.hasOwn(original, "stack")).toBe(false);
    expectWhitelisted(safe);
  });

  it("recursively sanitizes causes while preserving the original errors", () => {
    const token = "secret/cause?token=two";
    const cause = Object.assign(new Error(`inner diagnostic ${token}`), {
      command: { args: [token] },
      code: "ETIMEOUT",
    });
    cause.stack = `Error: inner diagnostic ${encodeURIComponent(token)}`;
    const original = new Error(`outer diagnostic ${token}`, { cause });
    const originalNames = Object.getOwnPropertyNames(original);
    const causeNames = Object.getOwnPropertyNames(cause);

    const safe = redactSessionError(original, [token]) as SessionError;

    expect(safe.cause).toBeInstanceOf(Error);
    expect(safe.cause).not.toBe(cause);
    expect((safe.cause as SessionError).message).toBe("inner diagnostic [Redacted]");
    expect((safe.cause as SessionError).code).toBe("ETIMEOUT");
    expect(serialized(safe)).toContain("outer diagnostic");
    expect(serialized(safe)).toContain("inner diagnostic");
    expect(serialized(safe)).not.toContain(token);
    expect(serialized(safe)).not.toContain(encodeURIComponent(token));
    expectWhitelisted(safe);
    expect(original.cause).toBe(cause);
    expect(Object.getOwnPropertyNames(original)).toEqual(originalNames);
    expect(Object.getOwnPropertyNames(cause)).toEqual(causeNames);
    expect(cause.command).toEqual({ args: [token] });
    expect(cause.message).toBe(`inner diagnostic ${token}`);
  });

  it.each([
    ["cause secret-token", "cause [Redacted]"],
    [42, "42"],
    [false, "false"],
    [null, "null"],
  ] as const)("normalizes the primitive cause %s", (cause, expectedMessage) => {
    const original = new Error("SAFE_DIAGNOSTIC", { cause });

    const safe = redactSessionError(original, ["secret-token"]);

    expect(safe.cause).toBeInstanceOf(Error);
    expect((safe.cause as Error).message).toContain(expectedMessage);
    expect(safe.message).toBe("SAFE_DIAGNOSTIC");
    expect(serialized(safe)).not.toContain("secret-token");
    expectWhitelisted(safe);
    expect(original.cause).toBe(cause);
  });

  it.each(["self", "pair"] as const)("terminates a %s cause cycle with serializable diagnostics", (kind) => {
    const first = new Error("first diagnostic") as SessionError;
    const second = new Error("second diagnostic", { cause: first });
    first.cause = kind === "self" ? first : second;

    const safe = redactSessionError(first, []);
    const visited = new Set<unknown>();
    let current: unknown = safe;
    let count = 0;
    while (current instanceof Error) {
      expect(visited.has(current)).toBe(false);
      visited.add(current);
      count += 1;
      expect(count).toBeLessThanOrEqual(3);
      current = current.cause;
    }

    expect(serialized(safe)).toContain("first diagnostic");
    expect(() => JSON.stringify(safe)).not.toThrow();
    expectWhitelisted(safe);
    expect(first.cause).toBe(kind === "self" ? first : second);
  });

  it.each([
    ["failed secret-token", "failed [Redacted]"],
    [42, "42"],
    [true, "true"],
    [false, "false"],
    [null, "null"],
    [undefined, "undefined"],
    [12n, "12"],
    [Symbol("secret-token"), "Symbol([Redacted])"],
  ] as const)("normalizes the primitive rejection %s", (value, expectedMessage) => {
    const safe = redactSessionError(value, ["secret-token"]);

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message).toContain(expectedMessage);
    expect(serialized(safe)).not.toContain("secret-token");
    expectWhitelisted(safe);
  });

  it("records the type of an object rejection without copying its properties", () => {
    const token = "secret-object-token";
    const original = { message: token, command: { args: [token] }, privatePayload: token };

    const safe = redactSessionError(original, [token]);

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message.toLowerCase()).toContain("object");
    expect(serialized(safe)).not.toContain(token);
    expect(serialized(safe)).not.toContain("command");
    expect(serialized(safe)).not.toContain("privatePayload");
    expectWhitelisted(safe);
    expect(original).toEqual({ message: token, command: { args: [token] }, privatePayload: token });
  });

  it("records the type of a function rejection without copying its source or properties", () => {
    /** Return a fixture credential embedded in the rejected function's source. */
    function rejectedFunction(): string {
      return "secret-token";
    }
    const original = Object.assign(rejectedFunction, {
      command: { args: ["secret-token"] },
      privatePayload: "secret-token",
    });

    const safe = redactSessionError(original, ["secret-token"]);

    expect(safe).toBeInstanceOf(Error);
    expect(safe.message.toLowerCase()).toContain("function");
    expect(serialized(safe)).not.toContain("secret-token");
    expect(serialized(safe)).not.toContain("rejectedFunction");
    expect(serialized(safe)).not.toContain("command");
    expect(serialized(safe)).not.toContain("privatePayload");
    expectWhitelisted(safe);
    expect(original()).toBe("secret-token");
    expect(original.command).toEqual({ args: ["secret-token"] });
  });

  it("redacts several literal secrets containing URI and regular-expression characters", () => {
    const secrets = ["cookie=a/b?c=1&d=2", "token.[*]+(value)$"];
    const values = secrets.flatMap((secret) => [secret, encodeURIComponent(secret)]);
    const original = new Error(`SAFE_DIAGNOSTIC ${values.join(" | ")}`);

    const safe = redactSessionError(original, secrets);

    expect(safe.message).toBe("SAFE_DIAGNOSTIC [Redacted] | [Redacted] | [Redacted] | [Redacted]");
    for (const value of values) expect(serialized(safe)).not.toContain(value);
    expectWhitelisted(safe);
  });

  it("keeps diagnostics unchanged for empty secret values", () => {
    const safe = redactSessionError(new Error("SAFE_DIAGNOSTIC"), [""]);

    expect(safe.message).toBe("SAFE_DIAGNOSTIC");
    expect(serialized(safe)).toContain("SAFE_DIAGNOSTIC");
    expectWhitelisted(safe);
  });

  it("preserves the diagnostic marker while protecting generated credentials", () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom("a", "B", "0", "/", "?", "=", ".", "*", "[", "]", "%", "&", " ", "+"), { maxLength: 30 }),
      (characters) => {
        const token = `session-secret-${characters.join("")}-end`;
        const encoded = encodeURIComponent(token);
        const cause = Object.assign(new Error(`CAUSE_DIAGNOSTIC ${encoded}`), { command: { args: [token] } });
        const original = Object.assign(new Error(`SAFE_DIAGNOSTIC ${token}`, { cause }), {
          command: { args: [`dev:session:${token}`] },
          vendorSecret: token,
        });
        original.stack = `Error: SAFE_DIAGNOSTIC ${encoded}`;

        const safe = redactSessionError(original, [token]);
        const wire = serialized(safe);

        expect(wire).toContain("SAFE_DIAGNOSTIC");
        expect(wire).toContain("CAUSE_DIAGNOSTIC");
        expect(wire).not.toContain(token);
        expect(wire).not.toContain(encoded);
        expect(wire).not.toContain("command");
        expect(wire).not.toContain("vendorSecret");
        expectWhitelisted(safe);
      },
    ));
  });
});
