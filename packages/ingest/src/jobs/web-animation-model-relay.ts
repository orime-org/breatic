// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `model.local` outbound relay of the web-animation container (inner#1711 design §6, DD §3.1; inner#1743).
 *
 * Every process in the container can reach `model.local`, so this relay, not the harness, decides what reaches a
 * model: only `POST /v1/messages` with a JSON body, handed to provider's Messages relay along the job's plan, which
 * rebuilds the body from the Messages field allowlist, clamps `max_tokens`, sends the plan's model, picks the upstream
 * and reads what the call cost.
 *
 * The Worker holds no model key (inner#1953): before each call the relay reads that call's keys for the plan's
 * upstreams from our server, and they live only in that call. A refusal for a missing key ends the job as
 * `account_key_missing`, one for a deployment without the keys as `feature_disabled`; our key is never used instead.
 *
 * Each call is registered with the job's Durable Object before it is sent and ended exactly once, whatever happens
 * to it; the object refuses a new call while one is open or once the job is stopping. A plain function so it runs on
 * Node in tests; the container class wires it to its outbound handler.
 */

import { relayMessages, type MessagesCallEnd, type MessagesPlan } from "@breatic/provider/messages";

import type { ModelKeysFetch } from "@ingest/jobs/web-animation-model-keys.js";

/** The fake host the container's harness sends model calls to. */
export const MODEL_HOST = "model.local";

/** What the relay needs: the job's plan and limits, the read of each call's keys and the job object's registry. */
export interface ModelRelayDeps {
  plan: MessagesPlan;
  /** Reads one call's keys for these upstreams of the plan. */
  fetchKeys: (upstreams: readonly string[]) => Promise<ModelKeysFetch>;
  maxTokens: number;
  callTimeoutMs: number;
  registry: {
    /** A seq for the new call, or null when the job refuses one. */
    beginModelCall: () => Promise<number | null>;
    recordModelCallStart: (seq: number, upstream: string, messageId: string) => Promise<void>;
    endModelCall: (seq: number, end: MessagesCallEnd) => Promise<void>;
    /** Ends the job failed for this reason, naming the upstream the refusal named. */
    failJob: (reason: string, upstream?: string) => Promise<void>;
  };
}

/**
 * Whether a value is a JSON object.
 * @param value - The value.
 * @returns True for a non-null, non-array object.
 * @throws {never} Never.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Relay one model call from the container along the job's plan.
 * @param request - What the harness sent to `model.local`.
 * @param deps - The job's plan and limits, the key read and the registry.
 * @returns The upstream answer, streamed; 403 for anything but `POST /v1/messages`, 400 for a body that is not a JSON
 *   object, 409 when the job refuses a call, the server refused the keys (the job then ends) or the execution no longer
 *   runs, 503 when the keys could not be read this time, a refusal as the upstream gave it, 502 when no upstream could
 *   be reached.
 * @throws {unknown} What the registry throws when the job object cannot be reached.
 */
export async function relayModelCall(request: Request, deps: ModelRelayDeps): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/messages") {
    return new Response("Not allowed", { status: 403 });
  }
  let asked: unknown;
  try {
    asked = JSON.parse(await request.text());
  } catch {
    return new Response("Not a Messages body", { status: 400 });
  }
  if (!isObject(asked)) return new Response("Not a Messages body", { status: 400 });

  const read = await deps.fetchKeys([...new Set(deps.plan.candidates.map(({ upstream }) => upstream))]);
  if (read.kind === "refused") {
    await deps.registry.failJob(read.reason, read.upstream);
    return new Response("The model keys were refused", { status: 409 });
  }
  if (read.kind === "not_running") return new Response("The execution no longer runs", { status: 409 });
  if (read.kind === "unavailable") return new Response("The model keys could not be read", { status: 503 });
  const { keys } = read;

  const seq = await deps.registry.beginModelCall();
  if (seq === null) return new Response("The job takes no model call now", { status: 409 });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deps.callTimeoutMs);
  const abandon = (): void => abort.abort();
  request.signal.addEventListener("abort", abandon);
  const version = request.headers.get("anthropic-version");
  return relayMessages(deps.plan, asked, {
    keyOf: (upstream) => (Object.hasOwn(keys, upstream) ? keys[upstream] : undefined),
    maxTokens: deps.maxTokens,
    signal: abort.signal,
    ...(version === null ? {} : { anthropicVersion: version }),
    onStarted: (upstream, messageId) => deps.registry.recordModelCallStart(seq, upstream, messageId),
    onEnded: async (end) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abandon);
      await deps.registry.endModelCall(seq, end);
    },
  });
}
