// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { REQUEST_SHAPE_PARAMS, t } from "@breatic/shared";

/**
 * `zValidator` is an overloaded function, and TypeScript does not give an
 * arrow function contextual parameter types from an overloaded annotation —
 * the parameters below come out implicitly `any` without this.
 */
type ValidatorArgs = Parameters<typeof zValidator>;

/**
 * zod issue codes that say the request's structure is not the route's: a
 * field missing or of another type, a key or enum value it does not know.
 * A page built before a release produces these. The rest (`too_big`,
 * `too_small`, `invalid_format`, `not_multiple_of`, `custom`) judge a value
 * against its limits, which is what a user's own input breaks.
 */
const STRUCTURAL_ISSUES: ReadonlySet<string> = new Set([
  "invalid_type",
  "unrecognized_keys",
  "invalid_union",
  "invalid_value",
  "invalid_key",
  "invalid_element",
]);

/**
 * Whether one zod issue is about the request's structure.
 * @param issue - The issue.
 * @param issue.code - Its zod code.
 * @param issue.params - A refine's params, when the issue came from one.
 * @returns True for a structural code, or a refine marked `REQUEST_SHAPE_PARAMS`.
 */
function isStructural(issue: { code: string; params?: Record<string, unknown> }): boolean {
  return STRUCTURAL_ISSUES.has(issue.code)
    || (issue.code === "custom" && issue.params?.requestShape === REQUEST_SHAPE_PARAMS.requestShape);
}

/**
 * A request refused because its structure does not fit the route's schema.
 * The error handler marks it with `REQUEST_SHAPE_REASON`, which a page built
 * before a release reads as "reload"; a refused value, and a
 * `ValidationError` a route throws for a well-formed request, stay unmarked.
 */
export class RequestShapeError extends ValidationError {
  /**
   * Construct a 422 shape refusal.
   * @param message - What the caller reads, already translated.
   */
  constructor(message: string) {
    super(message);
    this.name = "RequestShapeError";
  }
}

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
 *   Malformed JSON never reaches here, but only when the request declared
 *   itself JSON: hono attempts the parse on that Content-Type alone, and a
 *   failed attempt throws `HTTPException` from inside the validator, which
 *   the error handler answers with 400. The same broken body sent without
 *   that Content-Type is never parsed — the schema runs against `{}` and
 *   rejects it as a 422, which is the honest answer, since every field is
 *   missing as far as the server was allowed to look.
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
      const message = t("server.error.validation");
      throw result.error.issues.some(isStructural)
        ? new RequestShapeError(message)
        : new ValidationError(message);
    }
  });
};
