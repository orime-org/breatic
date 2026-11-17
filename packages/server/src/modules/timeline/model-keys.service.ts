// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keys of one web-animation model call, as the ingest Worker asks for them before each call (inner#1953). The
 * Worker holds no key of its own: it names the execution and the upstreams of its plan, and this answers only while
 * the execution runs and only for upstreams of the plan its job was fixed with. An execution that recorded an account
 * key row runs on that row alone, read by its id; a row replaced or deleted since is `account_key_missing`, and our
 * key is never sent instead. Without a row the deployment's keys answer. The keys leave sealed to the Worker's public
 * key; nothing here logs or returns a key in the clear.
 */

import { env, timelineExecutionRepo } from "@breatic/core";
import { keysById, provider } from "@breatic/domain";
import { accountKeyFailureIn, type KeySet } from "@breatic/provider";
import { sealModelKeys, webAnimationJobRequestSchema, type ModelKeysRefusal, type ModelKeysRequest } from "@breatic/shared/space-content";

/** What the endpoint answers. */
export type ModelKeysAnswer =
  | { kind: "sealed"; sealed: string }
  /** A definite refusal the Worker ends the execution on; `envVars` names what the deployment lacks, for the log. */
  | { kind: "refused"; refusal: ModelKeysRefusal; envVars?: string[] }
  /** The execution does not exist, is not running, or has no job fixed yet. */
  | { kind: "not_running" }
  /** An asked upstream is not in the execution's plan. */
  | { kind: "not_in_plan" }
  /** The deployment cannot seal: it has no public key for the Worker. */
  | { kind: "unsealable" };

/**
 * The plan the execution's job was fixed with, read from its stored step.
 * @param steps - The execution's steps.
 * @returns The plan's upstreams with their key variables, or null when no job was fixed yet.
 * @throws {never} Never.
 */
function planOf(steps: unknown[]): Map<string, string> | null {
  for (const step of steps) {
    const candidate = step as { kind?: unknown; request?: unknown } | null;
    if (candidate?.kind !== "container_job") continue;
    // Only the plan is read: a step stored before the job carried every field still names where its calls go.
    const plan = webAnimationJobRequestSchema.shape.messagesPlan.safeParse((candidate.request as { messagesPlan?: unknown } | null)?.messagesPlan);
    if (!plan.success || plan.data === undefined) return null;
    return new Map(plan.data.candidates.map(({ upstream, keyEnv }) => [upstream, keyEnv]));
  }
  return null;
}

/**
 * Answer one key request.
 * @param request - The execution and the upstreams the Worker asks for.
 * @returns The sealed keys, or why there are none.
 * @throws {Error} When the database or the global region cannot be read, or a sealed account key cannot be opened.
 */
export async function answerModelKeys(request: ModelKeysRequest): Promise<ModelKeysAnswer> {
  const row = await timelineExecutionRepo.findById(request.executionId);
  if (row === undefined || row.status !== "running") return { kind: "not_running" };
  const plan = planOf(row.steps);
  if (plan === null) return { kind: "not_running" };
  if (!request.upstreams.every((upstream) => plan.has(upstream))) return { kind: "not_in_plan" };

  const llmKeyId = await timelineExecutionRepo.llmKeyIdOf(row.id);
  let keys: KeySet;
  if (llmKeyId === null) {
    keys = provider().deploymentKeys;
  } else {
    try {
      keys = (await keysById(llmKeyId))!.keys;
    } catch (err) {
      const failure = accountKeyFailureIn(err);
      if (failure?.kind !== "account_key_missing") throw err;
      return { kind: "refused", refusal: { code: "account_key_missing", ...(failure.upstream === undefined ? {} : { upstream: failure.upstream }) } };
    }
  }

  const found: Record<string, string> = {};
  for (const upstream of request.upstreams) {
    const key = keys.keyOf(upstream);
    if (key !== undefined && key !== "") found[upstream] = key;
  }
  if (Object.keys(found).length === 0) {
    if (keys.owner === "account") return { kind: "refused", refusal: { code: "account_key_missing" } };
    return { kind: "refused", refusal: { code: "not_configured" }, envVars: request.upstreams.map((upstream) => plan.get(upstream)!) };
  }
  if (env.INGEST_KEY_SEAL_PUBLIC_KEY.trim() === "") return { kind: "unsealable" };
  return { kind: "sealed", sealed: await sealModelKeys(found, env.INGEST_KEY_SEAL_PUBLIC_KEY) };
}
