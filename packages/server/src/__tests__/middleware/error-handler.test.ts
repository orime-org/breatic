// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the exit answers for every kind of error that can reach it.
 *
 * This is the one place that decides what a client is told, so it has to
 * recognise every exception type that can arrive. It recognised two, and
 * everything else — including three shapes a client can trigger by sending a
 * bad request — fell into the branch that answers 500 and writes
 * `Unhandled error`, telling the caller the server broke when it did not.
 *
 * Which exception arrives depends on WHO parsed the body, measured with a
 * probe rather than assumed:
 *
 *   the validator middleware   bad field -> ZodError, caught by our hook
 *                              bad body  -> HTTPException(400), it catches
 *   a hand-written parse       bad field -> bare ZodError
 *   in a route handler         bad body  -> native SyntaxError
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

vi.mock("@breatic/core", async (importOriginal) => {
  // Everything real except the logger: the error family, `runWithLocale` and
  // `loadLocales` are what this suite is asserting against.
  const actual = await importOriginal<typeof import("@breatic/core")>();
  return { ...actual, logger: logged };
});

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

describe("a bare ZodError, as a hand-written parse throws", () => {
  it("answers 422, the status this repo already gives a failed check", async () => {
    const { status } = await answerFor(zodErrorForBadEmail());
    expect(status).toBe(422);
  });

  it("answers in our envelope, never zod's report", async () => {
    const { body } = await answerFor(zodErrorForBadEmail());
    expect(body.error).toMatchObject({ code: 422 });
    // zod 4 puts its whole report — including the email regex — in
    // `error.message`. None of that may reach a client.
    expect(JSON.stringify(body)).not.toContain("ZodError");
    expect(JSON.stringify(body)).not.toContain("invalid_format");
  });

  it("answers in the caller's language", async () => {
    const err = zodErrorForBadEmail();
    expect((await answerFor(err, "ja")).body.error?.message).toBe(
      INVALID_INPUT.ja,
    );
    expect((await answerFor(err, "en")).body.error?.message).toBe(
      INVALID_INPUT.en,
    );
  });

  it("does not write an error log", async () => {
    await answerFor(zodErrorForBadEmail());
    expect(logged.error).not.toHaveBeenCalled();
  });
});

describe("a native SyntaxError, as `await c.req.json()` throws in a route", () => {
  it("answers 400 — the body could not be read at all", async () => {
    const { status } = await answerFor(syntaxErrorForTruncatedJson());
    expect(status).toBe(400);
  });

  it("answers in our envelope, in the caller's language", async () => {
    const { body } = await answerFor(syntaxErrorForTruncatedJson(), "zh-CN");
    expect(body.error).toMatchObject({
      code: 400,
      message: INVALID_INPUT["zh-CN"],
    });
  });

  it("does not leak the parser's own message", async () => {
    // V8 writes things like `Unexpected end of JSON input` — an internal
    // detail, and English regardless of the caller.
    const { body } = await answerFor(syntaxErrorForTruncatedJson(), "zh-CN");
    expect(String(body.error?.message)).not.toContain("JSON");
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
