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
 * Takes a target and a schema and nothing else. The annotation is
 * `typeof zValidator` because that is what carries the inference every route
 * depends on — `c.req.valid(target)` keeps its exact type — but that
 * signature also advertises `zValidator`'s third and fourth parameters,
 * which this function does not forward. Rather than dropping them silently,
 * a call that passes them fails at mount time, which is process start.
 * @param target - Which part of the request to read: `json`, `query`,
 *   `param`, and the rest of hono's validation targets.
 * @param schema - The zod schema that part must satisfy.
 * @param rest - Nothing. Present only so an extra argument is refused
 *   loudly instead of being discarded; see above.
 * @returns Middleware that parses the target and hands the result to the
 *   route through `c.req.valid(target)`.
 * @throws {Error} at mount time when given more than a target and a schema.
 * @throws {ValidationError} 422 when the value does not satisfy the schema.
 *   A body that could not be parsed at all never reaches here — hono throws
 *   `HTTPException` from inside the validator first, which the error handler
 *   answers with 400.
 */
export const validate: typeof zValidator = (
  target: ValidatorArgs[0],
  schema: ValidatorArgs[1],
  ...rest: unknown[]
) => {
  if (rest.length > 0) {
    throw new Error(
      "validate() takes a target and a schema only. A failure hook passed here would never run — what a rejection answers is decided in error-handler.ts, for every route at once.",
    );
  }
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      // Built here, inside the request, so `t()` reads the locale
      // `localeMiddleware` pinned for this caller.
      throw new ValidationError(t("server.error.validation"));
    }
  });
};
