// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refuses a JSON body holding text the database cannot store (NUL, a lone
 * surrogate) on a signed internal listener: every internal endpoint writes
 * what it is sent, and Postgres would otherwise fail the write with a 500.
 * The product's and the billing service's internal listeners both mount it.
 */

import type { MiddlewareHandler } from "hono";
import { t } from "@breatic/shared";
import { ValidationError } from "@core/app-errors.js";
import { holdsOnlyStorableText } from "@core/util/storable-text.js";

/**
 * Refuse the request when its JSON body holds unstorable text.
 * @param c - The request context.
 * @param next - The rest of the app.
 * @returns Nothing; the route answers.
 * @throws {ValidationError} When the body holds such text.
 */
export const refuseUnstorableText: MiddlewareHandler = async (c, next) => {
  const text = await c.req.text();
  if (text !== "") {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Unparseable bodies are answered by the route's own validation.
      await next();
      return;
    }
    if (!holdsOnlyStorableText(body)) throw new ValidationError(t("server.internal.invalid_body"));
  }
  await next();
};
