// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `POST /mini-tools` decides before any row opens (inner#888 §6.1): the
 * model a model tool is pinned to and whether the request's values fit it,
 * the stored key a container tool reads, the params the run goes out with,
 * and what the credit precheck holds the reader to.
 */

import { AppError, env, getMiniToolsConfig, getStorageAdapter } from "@breatic/core";
import {
  creditsForUsd,
  estimateTaskCredits,
  MIN_TASK_CREDIT_COST,
  modelCatalog,
} from "@breatic/domain";
import {
  paramValueAllowed,
  t,
  type ModelEntry,
} from "@breatic/shared";
import {
  isModelTool,
  miniToolEstimateInput,
  type MiniToolRequest,
  type MiniToolSnapshot,
  type MiniToolSpec,
} from "@breatic/shared/mini-tools";

/** A run ready to queue. */
export interface PreparedRun {
  /** The pinned model; absent on a container tool. */
  model: string | undefined;
  /** What the run goes out with, recorded on the task. */
  params: Record<string, unknown>;
  /** The stored object a container tool reads. */
  sourceKey: string | undefined;
  /** What the precheck holds the reader to. */
  credits: number;
}

/**
 * The catalog entry a model is served under.
 * @param name - The model name.
 * @returns The entry, or undefined when this deployment does not serve it.
 */
function servedModel(name: string): ModelEntry | undefined {
  const catalog = modelCatalog.getModelCatalog();
  return [catalog.image, catalog.video, catalog.audio, catalog.tts, catalog.three_d]
    .flatMap((bucket) => bucket ?? [])
    .find((entry) => entry.name === name);
}

/**
 * The run as the estimate reads it.
 * @param body - The validated request.
 * @returns The snapshot.
 */
function snapshotOf(body: MiniToolRequest): MiniToolSnapshot {
  return {
    params: body.params,
    prompt: body.prompt ?? "",
    source: {
      url: body.source.url,
      ...(body.source.duration !== undefined && { duration: body.source.duration }),
    },
    slots: body.slots,
  };
}

/**
 * A model tool's run: the pinned model, its values held to the catalog, and
 * the source and slots written under the model params they fill.
 * @param spec - The tool.
 * @param body - The validated request.
 * @returns The prepared run.
 * @throws {AppError} 503 when the pinned model is not served; 400 when a value is one it does not take.
 */
async function prepareModelRun(spec: MiniToolSpec, body: MiniToolRequest): Promise<PreparedRun> {
  const model = spec.run.kind === "model" ? spec.run.model : "";
  const entry = servedModel(model);
  if (!entry) throw new AppError(503, t("server.mini_tool.unavailable"));
  for (const [name, value] of Object.entries(body.params)) {
    const declared = entry.params?.[name];
    if (declared && !paramValueAllowed(declared, value)) {
      throw new AppError(400, t("server.mini_tool.invalidParam", { name }));
    }
  }
  const snapshot = snapshotOf(body);
  const input = miniToolEstimateInput(spec, snapshot);
  const params: Record<string, unknown> = { ...input.params };
  if (spec.prompt) params.prompt = snapshot.prompt;
  return {
    model,
    params,
    sourceKey: undefined,
    credits: await estimateTaskCredits(model, input),
  };
}

/**
 * A container tool's run: the stored key it reads, and the precheck its
 * operation's expected seconds come to at the class's published prices.
 * @param op - The container operation.
 * @param body - The validated request.
 * @returns The prepared run.
 * @throws {AppError} 400 when the source is not one of our addresses.
 */
async function prepareContainerRun(op: string, body: MiniToolRequest): Promise<PreparedRun> {
  const sourceKey = (await getStorageAdapter()).keyFromUrl(body.source.url);
  if (sourceKey === null) throw new AppError(400, t("server.mini_tool.foreignSource"));
  const config = getMiniToolsConfig();
  const plan = config.ops[op as keyof typeof config.ops];
  const size = config.classes[plan.container_class]!;
  const perSecond =
    size.vcpu * config.prices.vcpu_second_usd +
    size.memory_gib * config.prices.memory_gib_second_usd +
    size.disk_gb * config.prices.disk_gb_second_usd;
  return {
    model: undefined,
    params: body.params,
    sourceKey,
    credits: Math.max(creditsForUsd(perSecond * plan.precheck_seconds, env.CREDIT_MULTIPLIER), MIN_TASK_CREDIT_COST),
  };
}

/**
 * Everything a server-run tool needs settled before its rows open.
 * @param spec - The tool the request names.
 * @param body - The validated request.
 * @returns The prepared run.
 * @throws {AppError} 503 / 400 as the two preparations state.
 */
export function prepareRun(spec: MiniToolSpec, body: MiniToolRequest): Promise<PreparedRun> {
  if (isModelTool(spec)) return prepareModelRun(spec, body);
  if (spec.run.kind === "container") return prepareContainerRun(spec.run.op, body);
  throw new AppError(400, t("server.mini_tool.unavailable"));
}
