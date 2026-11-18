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
 * The Worker holds no model key (inner#1953): each call runs on the keys the job was submitted with, sealed by our worker
 * and opened into the job object's memory only. When a restart of the object has emptied that memory, the call ends the
 * job as `key_lost_on_restart`. On a plan made on the payer's own keys, an upstream refusing that key for good ends the
 * job as `account_key_failed`; our key never stands in.
 *
 * Each call is registered with the job's Durable Object before it is sent and ended exactly once, whatever happens
 * to it; the object refuses a new call while one is open or once the job is stopping. A plain function so it runs on
 * Node in tests; the container class wires it to its outbound handler.
 */

import { relayMessages, type AccountKeyRefusal, type MessagesCallEnd, type MessagesPlan } from "@breatic/provider/messages";

/** The fake host the container's harness sends model calls to. */
export const MODEL_HOST = "model.local";

/** What the relay needs: the job's plan, limits and keys, and the job object's registry. */
export interface ModelRelayDeps {
  plan: MessagesPlan;
  /** The keys the job was submitted with, by upstream; null when a restart of the job object has lost them. */
  readKeys: () => Promise<Readonly<Record<string, string>> | null>;
  maxTokens: number;
  callTimeoutMs: number;
  registry: {
    /** A seq for the new call, or null when the job refuses one. */
    beginModelCall: () => Promise<number | null>;
    recordModelCallStart: (seq: number, upstream: string, messageId: string) => Promise<void>;
    endModelCall: (seq: number, end: MessagesCallEnd) => Promise<void>;
    /** Ends the job failed for this reason, naming the upstream and why it refused the payer's own key. */
    failJob: (reason: string, upstream?: string, keyReason?: AccountKeyRefusal["reason"]) => Promise<void>;
    notePassingKeyFailure: (reason: string, upstream: string, keyReason?: AccountKeyRefusal["reason"]) => Promise<void>;
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
 * @param deps - The job's plan, limits and keys, and the registry.
 * @returns The upstream answer, streamed; 403 for anything but `POST /v1/messages`, 400 for a body that is not a JSON
 *   object, 409 when the job refuses a call or has lost its keys (the job then ends), a refusal as the upstream gave
 *   it, 502 when no upstream could be reached.
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

  const keys = await deps.readKeys();
  if (keys === null) {
    await deps.registry.failJob("key_lost_on_restart");
    return new Response("The job lost its keys in a restart", { status: 409 });
  }

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
    // On the payer's own keys a key the upstream refused for good ends the job, and a passing failure is noted for the
    // job to fail with if the runner gives up; ours never stands in (inner#1953).
    onAccountKeyRefused: (refusal) => (refusal.lasting
      ? deps.registry.failJob(refusal.kind, refusal.upstream, refusal.reason)
      : deps.registry.notePassingKeyFailure(refusal.kind, refusal.upstream, refusal.reason)),
    onEnded: async (end) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abandon);
      await deps.registry.endModelCall(seq, end);
    },
  });
}
