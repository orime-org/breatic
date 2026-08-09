// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one way a route validates a request.
 *
 * `@hono/zod-validator` parses well; it answers badly. Its default failure
 * path is a single line — `if (!result.success) return c.json(result, 400)` —
 * which puts zod's own report on the wire. That is not our envelope, and its
 * text never passes through `t()`, so a request that asked for Chinese gets
 * an English string a library wrote. zod 4 packs the whole report into
 * `error.message`, down to the pattern it tested against, and the frontend
 * reads exactly that field.
 *
 * So we keep the parsing and take back the answering. The failure hook
 * throws; `errorHandler` decides the status, the shape and the language, the
 * same way it does for every other error in the product.
 * @see packages/server/src/middleware/error-handler.ts
 */

import { zValidator } from "@hono/zod-validator";
import { ValidationError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * `zValidator` is an overloaded function, and TypeScript does not give an
 * arrow function contextual parameter types from an overloaded annotation —
 * the parameters below come out implicitly `any` without this.
 */
type ValidatorArgs = Parameters<typeof zValidator>;

/**
 * Validate a request target against a schema, answering in our envelope.
 *
 * A drop-in for `zValidator(target, schema)` — same inference, so
 * `c.req.valid(target)` keeps its type — differing only in what a rejection
 * produces.
 *
 * Takes a target and a schema and nothing else. `zValidator`'s third
 * parameter is the failure hook, which is the very thing this function
 * exists to fix in one place; passing another one here has no effect,
 * because this hook throws before any hook of yours could answer.
 * @param target - Which part of the request to read: `json`, `query`,
 *   `param`, and the rest of hono's validation targets.
 * @param schema - The zod schema that part must satisfy.
 * @returns Middleware that parses the target and hands the result to the
 *   route through `c.req.valid(target)`.
 * @throws {ValidationError} 422 when the value does not satisfy the schema.
 *   A body that could not be parsed at all never reaches here — hono throws
 *   `HTTPException` from inside the validator first, which the error handler
 *   answers with 400.
 */
export const validate: typeof zValidator = (
  target: ValidatorArgs[0],
  schema: ValidatorArgs[1],
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      // Built here, inside the request, so `t()` reads the locale
      // `localeMiddleware` pinned for this caller.
      throw new ValidationError(t("server.error.validation"));
    }
  });
