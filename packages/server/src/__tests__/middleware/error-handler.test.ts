// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the exit answers for every kind of error that can reach it.
 *
 * Two exceptions arrive already carrying the fact that a client caused them —
 * an `AppError` we threw ourselves, and the `HTTPException` hono throws when
 * it cannot read the request body. Those get an answer built here. Everything
 * else is ours: 500 plus `Unhandled error`.
 *
 * The suite pins the second half as hard as the first, because a first
 * version of this handler recognised `ZodError` and `SyntaxError` by type and
 * answered them 400/422 "your input is invalid". The type says a parse
 * failed; it does not say whose input failed. Our own config loaders parse
 * operator-written yaml inside a request, and any `await response.json()` on
 * an upstream returning an HTML error page raises the same type — both were
 * being blamed on a user who had typed nothing wrong, with the log dropped.
 * The "a parse failure the handler must NOT blame on the caller" block below
 * is what keeps that shortcut from coming back: it throws each of those two
 * types and asserts 500 plus a log. The unrecognised-error test further down
 * would not catch it — a plain `Error` matches neither branch, so restoring
 * them leaves it green.
 *
 * @see packages/server/src/middleware/error-handler.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.hoisted` because `vi.mock` is lifted to the top of the file, above any
// plain `const` — the factory would otherwise read this before it exists.
const logged = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock(
  "@breatic/core",
  // The parameter is typed the way `helpers/mock-core.ts` types it, which is
  // what makes the result spreadable without an assertion.
  async (importOriginal: () => Promise<Record<string, unknown>>) => {
    // Everything real except the logger: the error family, `runWithLocale`
    // and `loadLocales` are what this suite asserts against.
    const actual = await importOriginal();
    return { ...actual, logger: logged };
  },
);

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AppError,
  ConflictLockedError,
  NotFoundError,
  loadLocales,
  runWithLocale,
} from "@breatic/core";

import { errorHandler } from "@server/middleware/error-handler.js";

loadLocales();

/** The message key every input rejection resolves to, per locale. */
const INVALID_INPUT = {
  en: "Invalid input",
  "zh-CN": "输入数据无效",
  ja: "入力データが無効です",
} as const;

/**
 * Build a one-route app whose handler throws whatever is handed in.
 * @param thrown - The error the route throws.
 * @returns An app mounting the real `errorHandler`.
 */
function appThrowing(thrown: unknown): Hono {
  const app = new Hono();
  app.onError(errorHandler);
  app.get("/boom", () => {
    throw thrown;
  });
  return app;
}

/**
 * Throw something at the exit and read back what a client would receive.
 * @param thrown - The error to throw from the route.
 * @param locale - Locale to pin for the request, as `localeMiddleware` does.
 * @returns The status and parsed body the client sees.
 */
async function answerFor(
  thrown: unknown,
  locale = "en",
): Promise<{ status: number; body: { error?: Record<string, unknown> } }> {
  const app = appThrowing(thrown);
  const res = await runWithLocale(locale, () => app.request("/boom"));
  return { status: res.status, body: await res.json() };
}

/** A real ZodError, produced the way a hand-written `.parse()` produces one. */
function zodErrorForBadEmail(): unknown {
  try {
    z.object({ email: z.email() }).parse({ email: "not-an-email" });
  } catch (err) {
    return err;
  }
  throw new Error("expected the schema to reject");
}

/** A real SyntaxError, produced by parsing a truncated body. */
function syntaxErrorForTruncatedJson(): unknown {
  try {
    JSON.parse('{"email":');
  } catch (err) {
    return err;
  }
  throw new Error("expected JSON.parse to reject");
}

beforeEach(() => {
  logged.error.mockClear();
  logged.warn.mockClear();
});

describe("a body the validator middleware could not read", () => {
  // hono throws this from inside the validator, before the schema runs, and it
  // already carries the status it wants: 400. We were downgrading it to 500.
  it("answers with the status the exception carries, not 500", async () => {
    const { status } = await answerFor(
      new HTTPException(400, { message: "Malformed JSON in request body" }),
    );
    expect(status).toBe(400);
  });

  it("answers in our envelope", async () => {
    const { body } = await answerFor(new HTTPException(400));
    expect(body.error).toMatchObject({ code: 400 });
    expect(typeof body.error?.message).toBe("string");
  });

  it("does not pass hono's English text through", async () => {
    // It is hardcoded English and it names our internals; neither belongs on
    // the wire. The status is hono's to decide, the wording is ours.
    const { body } = await answerFor(
      new HTTPException(400, { message: "Malformed JSON in request body" }),
      "zh-CN",
    );
    expect(body.error?.message).toBe(INVALID_INPUT["zh-CN"]);
  });

  it("does not write an error log — a bad request is not our incident", async () => {
    await answerFor(new HTTPException(400));
    expect(logged.error).not.toHaveBeenCalled();
  });

  it("still logs when the exception carries a 5xx", async () => {
    await answerFor(new HTTPException(503));
    expect(logged.error).toHaveBeenCalled();
  });
});

describe("a parse failure the handler must NOT blame on the caller", () => {
  // These two types were briefly recognised and answered "your input is
  // invalid". A parse failure says a parse failed — it does not say whose
  // input failed, and the ones that actually reach here are ours.

  it("answers 500 for a ZodError, the shape our config loaders raise", async () => {
    // `config/rate-limits.ts` and three siblings parse operator-written yaml
    // lazily, inside the first request that needs them. A typo there is our
    // outage, not the caller's typo.
    const { status } = await answerFor(zodErrorForBadEmail());
    expect(status).toBe(500);
  });

  it("logs the ZodError, so the yaml typo is findable", async () => {
    await answerFor(zodErrorForBadEmail());
    expect(logged.error).toHaveBeenCalled();
  });

  it("answers 500 for a SyntaxError, the shape an upstream HTML page raises", async () => {
    // `await someResponse.json()` on a provider that answered with an error
    // page. Telling the user their input was invalid would be a lie, and a
    // lie that hides the outage.
    const { status } = await answerFor(syntaxErrorForTruncatedJson());
    expect(status).toBe(500);
  });

  it("logs the SyntaxError", async () => {
    await answerFor(syntaxErrorForTruncatedJson());
    expect(logged.error).toHaveBeenCalled();
  });

  it("still says nothing about the parse in the response", async () => {
    // 500 is honest about who is at fault; the wording stays ours, and the
    // parser's own text (`Unexpected end of JSON input`) is an internal
    // detail, English regardless of the caller.
    const { body } = await answerFor(syntaxErrorForTruncatedJson(), "zh-CN");
    expect(String(body.error?.message)).not.toContain("JSON");
    expect(JSON.stringify(body)).not.toContain("ZodError");
  });
});

describe("what the exit already did, still does", () => {
  it("keeps AppError's status and its own message", async () => {
    const { status, body } = await answerFor(new NotFoundError("no such team"));
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: 404, message: "no such team" });
  });

  it("keeps ConflictLockedError's structured detail", async () => {
    const detail = {
      holdingBy: "u1",
      holdingByName: "Ada",
      taskId: "t1",
      startedAt: 1,
      estimatedSeconds: 12,
    };
    const { status, body } = await answerFor(new ConflictLockedError(detail));
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: 409, detail });
  });

  it("warns on an auth rejection", async () => {
    await answerFor(new AppError(403, "nope"));
    expect(logged.warn).toHaveBeenCalled();
  });

  it("still answers 500 and logs for an error it does not recognise", async () => {
    const { status } = await answerFor(new Error("something we did wrong"));
    expect(status).toBe(500);
    expect(logged.error).toHaveBeenCalled();
  });

  it("does not leak an unrecognised error's message", async () => {
    const { body } = await answerFor(new Error("connection string: secret"));
    expect(String(body.error?.message)).not.toContain("secret");
  });
});
