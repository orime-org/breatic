// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What `POST /mini-tools` decides before any row opens (inner#888 §6.1): the
 * model a model tool is pinned to and whether the request's values fit it,
 * the stored key a container tool reads, the params the run goes out with,
 * and what the credit precheck holds the reader to.
 */

import { AppError, env, getMiniToolsConfig, getStorageAdapter, logger } from "@breatic/core";
import {
  assetRepo,
  containerCostUsd,
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
  catalogEntryOf,
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
 * The prompt a run is sent: an empty one on a tool that has its own is sent as
 * that one, and a tool's preamble goes before whatever the reader wrote.
 * @param spec - The tool.
 * @param typed - What the reader wrote.
 * @returns The prompt.
 */
function promptOf(spec: MiniToolSpec, typed: string): string {
  const empty = typed.trim() === "";
  const preamble = spec.prompt?.preamble;
  if (preamble !== undefined) return empty ? preamble : `${preamble} Also: ${typed.trim()}`;
  return empty && spec.prompt?.defaultText !== undefined ? spec.prompt.defaultText : typed;
}

/**
 * The catalog ratio nearest a size, by how far apart the two shapes are on a
 * log scale, so 2:1 and 1:2 are as far from 1:1 as each other.
 * @param values - The param's values; `a:b` ones are candidates.
 * @param width - The source's width.
 * @param height - The source's height.
 * @returns The nearest ratio, or `auto` when none is a ratio.
 */
function nearestRatio(values: readonly unknown[], width: number, height: number): string {
  const shape = Math.log(width / height);
  let best = "auto";
  let gap = Infinity;
  for (const value of values) {
    const match = typeof value === "string" ? /^(\d+):(\d+)$/.exec(value) : null;
    if (match === null) continue;
    const d = Math.abs(Math.log(Number(match[1]) / Number(match[2])) - shape);
    if (d < gap) {
      gap = d;
      best = value as string;
    }
  }
  return best;
}

/**
 * The run as the estimate reads it, with the ratio a tool takes from its
 * source written in when the request says the source's size.
 * @param spec - The tool.
 * @param body - The validated request.
 * @param entry - The pinned model's catalog entry.
 * @returns The snapshot.
 */
function snapshotOf(spec: MiniToolSpec, body: MiniToolRequest, entry: ModelEntry): MiniToolSnapshot {
  const params: Record<string, unknown> = { ...body.params };
  const aspect = spec.sourceAspectParam;
  if (aspect !== undefined) {
    const { width, height } = body.source;
    params[aspect] =
      width !== undefined && height !== undefined ? nearestRatio(entry.params[aspect]?.values ?? [], width, height) : "auto";
  }
  return {
    params,
    prompt: promptOf(spec, body.prompt ?? ""),
    source: {
      url: body.source.url,
      ...(body.source.duration !== undefined && { duration: body.source.duration }),
    },
    slots: body.slots,
    ...(body.drawing !== undefined && { drawing: body.drawing }),
    ...(body.expand !== undefined && { expand: body.expand }),
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
  const entry = catalogEntryOf(modelCatalog.getModelCatalog(), model);
  if (!entry) throw new AppError(503, t("server.mini_tool.unavailable"));
  for (const [name, value] of Object.entries(body.params)) {
    const declared = entry.params?.[name];
    if (declared && !paramValueAllowed(declared, value)) {
      throw new AppError(400, t("server.mini_tool.invalidParam", { name }));
    }
  }
  const snapshot = snapshotOf(spec, body, entry);
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
 * @throws {AppError} 400 when the source is not one of our addresses, or not a video.
 */
async function prepareContainerRun(op: string, body: MiniToolRequest): Promise<PreparedRun> {
  const sourceKey = (await getStorageAdapter()).keyFromUrl(body.source.url);
  if (sourceKey === null) throw new AppError(400, t("server.mini_tool.foreignSource"));
  // Every container operation reads a video; the panel only offers video
  // nodes, so another kind here came from a forged request.
  const kind = await assetRepo.findKindByStorageKey(sourceKey);
  if (kind !== "video") {
    logger.warn({ op, sourceKey, kind }, "mini_tool_source_not_video");
    throw new AppError(400, t("server.mini_tool.foreignSource"));
  }
  const config = getMiniToolsConfig();
  const plan = config.ops[op as keyof typeof config.ops];
  const size = config.classes[plan.container_class]!;
  // The expected run billed as the charge bills it, with the full vCPU for its time.
  const usd = containerCostUsd({ wallMs: plan.precheck_seconds * 1000, cpuUsec: null }, size, config.prices);
  return {
    model: undefined,
    params: body.params,
    sourceKey,
    credits: Math.max(creditsForUsd(usd, env.CREDIT_MULTIPLIER), MIN_TASK_CREDIT_COST),
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
