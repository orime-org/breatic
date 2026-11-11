// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What `POST /mini-tools` decides before any row opens (inner#888 §6.1): the
 * model a model tool is pinned to and whether the request's values fit it,
 * the stored key a container tool reads, the params the run goes out with,
 * and what the credit precheck holds the user to.
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
  formatBytes,
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
  /**
   * Every stored object a container tool reads, in order, the source first; a
   * join's clips follow it (inner#1825 §6.4). Absent on a model tool.
   */
  inputKeys?: string[];
  /** What the precheck holds the user to. */
  credits: number;
}

/**
 * The prompt a run is sent: an empty one on a tool that has its own is sent as
 * that one, and a tool's preamble goes before whatever the user wrote.
 * @param spec - The tool.
 * @param typed - What the user wrote.
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
 * Refuse a source the pinned model takes no longer or larger than (inner#1305),
 * measured by what the ledger recorded of the stored file rather than what the
 * request claims. A file the ledger has not measured goes through, and the
 * model answers for it.
 * @param spec - The tool.
 * @param body - The validated request.
 * @param entry - The pinned model's catalog entry.
 * @returns Nothing.
 * @throws {AppError} 400 when the stored file is past either ceiling.
 */
async function assertSourceWithinModel(spec: MiniToolSpec, body: MiniToolRequest, entry: ModelEntry): Promise<void> {
  const declared = entry.params?.[spec.sourceParam];
  const maxSeconds = declared?.max_total_duration;
  const maxBytes = declared?.max_bytes;
  if (maxSeconds === undefined && maxBytes === undefined) return;
  const key = (await getStorageAdapter()).keyFromUrl(body.source.url);
  const measured = key === null ? null : await assetRepo.findLiveByStorageKey(key);
  if (measured === null) return;
  if (maxSeconds !== undefined && measured.durationSeconds !== null && measured.durationSeconds > maxSeconds) {
    throw new AppError(400, t("server.mini_tool.sourceTooLong", { minutes: Math.round(maxSeconds / 60) }));
  }
  if (maxBytes !== undefined && measured.sizeBytes > maxBytes) {
    throw new AppError(400, t("server.mini_tool.sourceTooLarge", { size: formatBytes(maxBytes) }));
  }
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
  await assertSourceWithinModel(spec, body, entry);
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
 * The stored key behind one input of a container tool, checked as the source
 * is: one of our addresses, filed as the tool's medium; read with its size
 * from the one ledger row.
 * @param spec - The tool, whose declared source medium the stored file must be.
 * @param op - The container operation, for the log.
 * @param url - The input's address.
 * @returns Its storage key and the size the ledger holds for it.
 * @throws {AppError} 400 when the input is not one of our addresses, or not the tool's medium.
 */
async function checkedInput(spec: MiniToolSpec, op: string, url: string): Promise<{ key: string; sizeBytes: number }> {
  const key = (await getStorageAdapter()).keyFromUrl(url);
  if (key === null) throw new AppError(400, t("server.mini_tool.foreignSource"));
  // A container operation reads the medium its tool declares; the panel only
  // offers a tool on a node of that medium, so another kind here came from a
  // forged request.
  const row = await assetRepo.findLiveByStorageKey(key);
  if (row?.kind !== spec.source) {
    logger.warn({ op, sourceKey: key, kind: row?.kind ?? null, expected: spec.source }, "mini_tool_source_wrong_kind");
    throw new AppError(400, t("server.mini_tool.foreignSource"));
  }
  return { key, sizeBytes: row.sizeBytes };
}

/**
 * A container tool's run: the stored keys it reads, and the precheck its
 * operation's expected seconds come to at the class's published prices. A
 * tool with slots (the joins, inner#1825 §6.4) also reads every slot's clips
 * after the source, between 1 and `join_max_clips − 1` of them, and their
 * bytes twice over (read, then written again as the output) must fit the
 * class's disk.
 * @param spec - The tool, whose declared source medium every stored file must be.
 * @param op - The container operation.
 * @param body - The validated request.
 * @returns The prepared run.
 * @throws {AppError} 400 when an input is not one of our addresses or not the tool's medium, when the clip count is out of range, or when the clips are too large together.
 */
async function prepareContainerRun(spec: MiniToolSpec, op: string, body: MiniToolRequest): Promise<PreparedRun> {
  const config = getMiniToolsConfig();
  const source = await checkedInput(spec, op, body.source.url);
  const inputKeys = [source.key];
  const plan = config.ops[op as keyof typeof config.ops];
  const size = config.classes[plan.container_class]!;
  // ponytail: the joins are the only container tools with slots, so slots mean a join.
  if (spec.slots.length > 0) {
    const clips = spec.slots.flatMap((slot) => body.slots[slot.key] ?? []);
    // The panel holds a join to the cap; a request past it is said as the count.
    if (clips.length < 1 || clips.length > config.join_max_clips - 1) {
      throw new AppError(400, t("server.mini_tool.joinClipCount", { max: config.join_max_clips }));
    }
    let bytes = source.sizeBytes;
    for (const clip of clips) {
      const input = await checkedInput(spec, op, clip.url);
      inputKeys.push(input.key);
      bytes += input.sizeBytes;
    }
    if (bytes * 2 > size.disk_gb * 1_000_000_000) {
      throw new AppError(400, t("server.mini_tool.clipsTooLarge"));
    }
  }
  // The expected run billed as the charge bills it, with the full vCPU for its time.
  const usd = containerCostUsd({ wallMs: plan.precheck_seconds * 1000, cpuUsec: null }, size, config.prices);
  return {
    model: undefined,
    params: body.params,
    sourceKey: source.key,
    inputKeys,
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
  if (spec.run.kind === "container") return prepareContainerRun(spec, spec.run.op, body);
  throw new AppError(400, t("server.mini_tool.unavailable"));
}
