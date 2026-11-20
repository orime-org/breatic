// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admission of a video mini-tool's model calls (inner#1306 execution design §11.5): every call runs on the upstream
 * its model was measured on, frozen into the plan; before anything is held or queued, each planned call must be one an
 * upstream here can serve and takes, and is priced on that route.
 */

import { AppError, ValidationError } from "@breatic/core";
import type { Route } from "@breatic/provider";
import { inputRefusalText, t } from "@breatic/shared";
import type { EstimateInput } from "@breatic/shared/pricing";
import { estimateModelCredits, findCatalogEntry, inputRefusalFor, servability } from "@domain/model-catalog/model-catalog.js";
import { provider } from "@domain/provider/instance.js";

/** The route every video mini-tool model call takes: the one upstream the tools' models and recipes were measured on. */
export const MINI_TOOL_MODEL_ROUTE = { mode: "upstream", upstream: "wavespeed" } as const satisfies Route;

/**
 * Admit one planned model call and price it: refused when no upstream here with its key serves it on the frozen route,
 * or when the upstream does not take it (a vendor limit such as a length in seconds).
 * @param model - The catalog model.
 * @param input - The call, as it is priced.
 * @returns Its credits as the catalog estimates them.
 * @throws {AppError} 503 when the model is not in the catalog, not configured here or not priced.
 * @throws {ValidationError} When the route names an upstream the model is not bound on, or the upstream refuses the call.
 */
export async function admitModelCall(model: string, input: EstimateInput): Promise<number> {
  const entry = findCatalogEntry(model);
  if (entry === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  const name = entry.display_name ?? entry.name;
  const served = servability(model, MINI_TOOL_MODEL_ROUTE);
  if (!served.servable) {
    if (served.reason === "unbound") throw new ValidationError(t("server.model.upstream_not_bound", { model: name, upstream: served.upstream }));
    throw new AppError(503, t("server.model.not_configured", { model: name, envVars: served.envVars.join(", ") }));
  }
  const refusal = await inputRefusalFor(model, input, MINI_TOOL_MODEL_ROUTE);
  if (refusal !== null) throw new ValidationError(inputRefusalText(refusal, name));
  const estimate = await estimateModelCredits(model, input, MINI_TOOL_MODEL_ROUTE);
  if (estimate === undefined) throw new AppError(503, t("server.mini_tool.unavailable"));
  return estimate.credits;
}

/**
 * The seconds a model's vendor takes per call (inner#1306 execution design §11.5): written once, as the `seconds` limits
 * of its provider rejects, and read from there by the panel limits, admission and the product guide.
 * @param model - The catalog model.
 * @returns The shortest length (0 when no reject states one) and the longest (null when none states one).
 */
export function modelSecondsRange(model: string): { minSeconds: number; maxSeconds: number | null } {
  let minSeconds = 0;
  let maxSeconds: number | null = null;
  for (const limit of provider().inputLimits(model)) {
    if (limit.measure !== "seconds") continue;
    if (limit.min !== undefined) minSeconds = Math.max(minSeconds, limit.min);
    if (limit.max !== undefined) maxSeconds = maxSeconds === null ? limit.max : Math.min(maxSeconds, limit.max);
  }
  return { minSeconds, maxSeconds };
}
