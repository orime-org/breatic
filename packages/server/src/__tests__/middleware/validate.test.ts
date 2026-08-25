// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one way a route validates a request.
 *
 * `@hono/zod-validator`'s default failure path is a single line —
 * `if (!result.success) return c.json(result, 400)` — which sends zod's own
 * report as the response body. That body is not our envelope, and its text is
 * hardcoded English that never passes through `t()`, so a request that asked
 * for Chinese gets an English string built by a library. zod 4 packs the whole
 * report into `error.message`, down to the regex it tested against, and the
 * frontend reads exactly that field.
 *
 * `validate` keeps the library's parsing and takes back the answering: the
 * failure hook throws, the exception reaches `errorHandler`, and every error
 * response in the product is produced in one place, in the caller's language.
 *
 * @see packages/server/src/middleware/validate.ts
 * @see packages/server/src/middleware/error-handler.ts
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { loadLocales, runWithLocale } from "@breatic/core";

import { validate } from "@server/middleware/validate.js";
import { errorHandler } from "@server/middleware/error-handler.js";

loadLocales();

/** What `server.error.validation` reads as, per locale. */
const INVALID_INPUT = {
  en: "Invalid input",
  "zh-CN": "输入数据无效",
  ko: "입력값이 유효하지 않습니다",
} as const;

const bodySchema = z.object({ email: z.email(), age: z.number().int() });
const querySchema = z.object({ limit: z.coerce.number().int().max(100) });
const paramSchema = z.object({ id: z.uuid() });

/** An app mounting every target shape a route can validate. */
function buildApp(): Hono {
  const app = new Hono();
  app.onError(errorHandler);

  app.post("/json", validate("json", bodySchema), (c) => {
    // Reading it back proves the parsed value still reaches the handler —
    // and, at compile time, that the inferred type survived the wrapper.
    const body = c.req.valid("json");
    return c.json({ echoed: body.email, age: body.age });
  });

  app.get("/query", validate("query", querySchema), (c) =>
    c.json({ limit: c.req.valid("query").limit }),
  );

  app.get("/param/:id", validate("param", paramSchema), (c) =>
    c.json({ id: c.req.valid("param").id }),
  );

  return app;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Send a request with a locale pinned, the way `localeMiddleware` does.
 * @param path - Path to request.
 * @param init - Fetch init passed through to the app.
 * @param locale - Locale to pin for this request.
 * @returns The status and parsed JSON body.
 */
async function request(
  path: string,
  init: RequestInit = {},
  locale = "en",
): Promise<{ status: number; body: Record<string, never> }> {
  const res = await runWithLocale(locale, () => buildApp().request(path, init));
  return { status: res.status, body: await res.json() };
}

describe("a request that passes its schema", () => {
  it("reaches the handler with the parsed value", async () => {
    const { status, body } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "ada@example.com", age: 36 }),
    });
    expect(status).toBe(200);
    expect(body).toEqual({ echoed: "ada@example.com", age: 36 });
  });

  it("applies the schema's coercion on query values", async () => {
    const { status, body } = await request("/query?limit=20");
    expect(status).toBe(200);
    // `z.coerce.number()` — the handler must see 20, not "20".
    expect(body).toEqual({ limit: 20 });
  });
});

describe("a request whose field fails the schema", () => {
  it("answers 422", async () => {
    const { status } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "not-an-email", age: 36 }),
    });
    expect(status).toBe(422);
  });

  it("answers in our envelope", async () => {
    const { body } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "not-an-email", age: 36 }),
    });
    expect(body).toEqual({ error: { code: 422, message: INVALID_INPUT.en } });
  });

  it("never puts zod's report on the wire", async () => {
    const { body } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "not-an-email", age: 36 }),
    });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("ZodError");
    expect(wire).not.toContain("invalid_format");
    // The pattern zod tested against — how we check, which is ours to keep.
    expect(wire).not.toContain("A-Za-z0-9");
  });

  it("answers in the caller's language", async () => {
    for (const [locale, expected] of Object.entries(INVALID_INPUT)) {
      const { body } = await request(
        "/json",
        {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ email: "not-an-email", age: 36 }),
        },
        locale,
      );
      expect(body).toEqual({ error: { code: 422, message: expected } });
    }
  });

  it("does not name the field that failed", async () => {
    // Decided 2026-08-09: a user knows what they just typed. Naming the field
    // is also a description of our schema, which we do not owe a caller.
    const { body } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "not-an-email", age: 36 }),
    });
    expect(JSON.stringify(body)).not.toContain("email");
  });
});

describe("every target a route can validate", () => {
  it("rejects a bad query the same way", async () => {
    const { status, body } = await request("/query?limit=999");
    expect(status).toBe(422);
    expect(body).toEqual({ error: { code: 422, message: INVALID_INPUT.en } });
  });

  it("rejects a bad path parameter the same way", async () => {
    const { status, body } = await request("/param/not-a-uuid");
    expect(status).toBe(422);
    expect(body).toEqual({ error: { code: 422, message: INVALID_INPUT.en } });
  });
});

describe("a body that could not be read at all", () => {
  it("answers 400, not 422 — nothing was parsed to reject", async () => {
    const { status } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: '{"email":',
    });
    expect(status).toBe(400);
  });

  it("answers in our envelope, in the caller's language", async () => {
    const { body } = await request(
      "/json",
      { method: "POST", headers: JSON_HEADERS, body: '{"email":' },
      "zh-CN",
    );
    expect(body).toEqual({
      error: { code: 400, message: INVALID_INPUT["zh-CN"] },
    });
  });

  it("answers 400 for an empty body too", async () => {
    const { status } = await request("/json", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "",
    });
    expect(status).toBe(400);
  });

  it("falls to the schema when no Content-Type declares JSON", async () => {
    // hono's validator skips parsing entirely unless the request declares
    // JSON, so the schema sees `{}` and rejects it as a missing field. The
    // same broken body therefore answers 422 here and 400 above — measured,
    // and worth pinning so the difference is not mistaken for a defect.
    const { status } = await request("/json", {
      method: "POST",
      body: '{"email":',
    });
    expect(status).toBe(422);
  });
});

describe("an extra argument", () => {
  it("is refused at mount time rather than dropped", () => {
    // `typeof zValidator` is what carries the inference every route depends
    // on, and it advertises a third parameter this function does not
    // forward. Silently discarding a hook someone wrote would send them
    // hunting through the library; failing here fails at process start.
    // No `@ts-expect-error` here, and that absence is the point: the
    // annotation genuinely accepts a third argument, so the type system
    // cannot be the one to catch this. Adding the directive fails typecheck
    // with "Unused '@ts-expect-error' directive" — measured, 2026-08-10.
    expect(() =>
      validate("json", bodySchema, () => undefined),
    ).toThrow(/takes a target and a schema only/);
  });

  it("still builds middleware for the two-argument call", () => {
    expect(() => validate("json", bodySchema)).not.toThrow();
  });
});
