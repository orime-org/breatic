// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A run of a model no upstream can serve here is refused before anything is queued (inner#1743): every model is
 * listed whatever this deployment has configured, so the refusal names what is missing for whoever deploys it.
 */

import { AppError, logger, ValidationError } from "@breatic/core";
import { inputRefusalFor, llmServability, servability, type Servability } from "@breatic/domain";
import type { Route } from "@breatic/provider";
import { inputRefusalText, t } from "@breatic/shared";
import type { EstimateInput } from "@breatic/shared/pricing";

/**
 * Refuse a run of a model this deployment cannot serve on its route.
 * @param model - The model's name.
 * @param displayName - What the user knows the model as.
 * @param route - How the run chooses its upstream; the weights when left out.
 * @throws {AppError} 503 when no upstream the route may use has its key, naming the variables it reads.
 * @throws {ValidationError} When the route names an upstream the model is not offered through.
 */
export function assertServable(model: string, displayName: string, route?: Route): void {
  refuseUnservable(servability(model, route), displayName);
}

/**
 * Refuse a language model call this deployment cannot serve.
 * @param model - Our model id, which is also what the user knows it as.
 * @param use - `call` for chat, consolidation and the text tools; `understand` for reading media.
 * @param route - How the call chooses its upstream; the weights when left out.
 * @throws {AppError} 503 when no upstream of that use the route may use has its key, naming the variables they read.
 * @throws {ValidationError} When the route names an upstream the model has no route on.
 */
export function assertLlmServable(model: string, use: "call" | "understand", route?: Route): void {
  refuseUnservable(llmServability(model, use, route), model);
}

/**
 * Throw the refusal a model that cannot be served here answers with.
 * @param served - Whether it can, and why not.
 * @param displayName - What the user knows the model as.
 * @throws {AppError} 503 when no upstream has its key.
 * @throws {ValidationError} When the route names an upstream the model is not offered through.
 */
function refuseUnservable(served: Servability, displayName: string): void {
  if (served.servable) return;
  if (served.reason === "unbound") {
    throw new ValidationError(t("server.model.upstream_not_bound", { model: displayName, upstream: served.upstream }));
  }
  throw new AppError(503, t("server.model.not_configured", { model: displayName, envVars: served.envVars.join(", ") }));
}

/**
 * Refuse a run no upstream here that its route may use takes (#1521), before anything is held or queued: the user is
 * told which limit it broke, and the refusal is logged with the upstream's own words for whoever deploys it.
 * @param model - The model's name.
 * @param displayName - What the user knows the model as.
 * @param input - The run as the request describes it, as it is priced.
 * @param route - How the run chooses its upstream; the weights when left out.
 * @param context - Who and where, for the log line.
 * @returns Nothing when an upstream takes the run.
 * @throws {ValidationError} When none does, naming the limit.
 */
export async function assertTakesInput(
  model: string,
  displayName: string,
  input: EstimateInput,
  route: Route | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  const refusal = await inputRefusalFor(model, input, route);
  if (refusal === null) return;
  logger.warn({ ...context, model, reason: "input_refused", refusal }, "execute_gate_rejected");
  throw new ValidationError(inputRefusalText(refusal, displayName));
}
