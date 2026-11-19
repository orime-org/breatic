// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why a task failed, for the causes we author (#186 §7.1).
 *
 * A task's `error_message` is read by whoever opens the node's task list, in
 * whatever language they set. A sentence written at the point of failure is
 * frozen into one language at that moment — the server's, or whichever
 * requester happened to trigger it — and every other user gets that one.
 *
 * So the causes we know are stored as a code and turned into a sentence where
 * the user is. A provider's own error text is not one of these: it is what
 * the provider said, and it travels as itself.
 */

import type { InputLimitShape } from "@shared/input-refusal.js";
import {
  INGEST_FAILURE_CODES,
  INGEST_NO_ANSWER,
  INGEST_NOT_STARTED,
  INGEST_REFUSED_UNNAMED,
  INGEST_TYPE_NOT_REPORTED,
} from "@shared/upload/ingest-failure.js";

/** The causes this product recognises. */
export const TASK_FAILURE_REASONS = [
  /** The browser gave up sending, or its own retries ran out. */
  "aborted",
  /** What landed is larger than an upload is allowed to be. */
  "over_cap",
  /**
   * The file is larger than a reading takes.
   *
   * Separate from `over_cap` because they are different ceilings on
   * different files: this one names a file that uploaded fine and is on the
   * canvas, so the upload sentence would be a false statement about it.
   */
  "understand_over_cap",
  /** The deadline passed with no result. */
  "expired",
  /** The run finished, and came back with nothing to put on the node. */
  "no_result",
  /** The address would not open. */
  "source_unreachable",
  /** The address stopped sending before the file was complete. */
  "source_cut_off",
  /** What arrived is not a kind a node can hold. */
  "unsupported_type",
  /**
   * The file is not a format a reading takes.
   *
   * Separate from `unsupported_type` for the same reason `understand_over_cap`
   * is separate from `over_cap`: the two lanes judge against two tables that
   * differ. A reading takes `image/gif` and `video/mpeg`, which an upload
   * refuses, so one code for both means one sentence naming the wrong list.
   */
  "understand_unsupported_type",
  /**
   * Nothing arrived: an address that answered empty, or a backend upload
   * opened for bytes that turned out not to exist.
   */
  "empty",
  /**
   * Something on our side broke. The address was fine; sending it again is
   * what the person does next, and which part broke is in the log.
   */
  "internal",
  /**
   * The account has no credits left. The row exists because the node was
   * already on the canvas when this was found — a run refused before it
   * started still has somewhere to say so.
   */
  "no_credits",
  /**
   * The studio's balance covers the run, but running work holds what it
   * needs. Separate from `no_credits` because there are credits: they are
   * spoken for until that work is charged or ends.
   */
  "credits_held",
  /**
   * A model's safety gate refused this question. Asking it differently may
   * get an answer; nothing on our side broke.
   */
  "declined",
  /**
   * A model refused these bytes. The same file asked again answers the same
   * way, so repeating it is not what the person does next.
   */
  "media_refused",
  /**
   * A mini-tool's container run did not finish: the tool failed on this file,
   * ran out of time, or stopped before it wrote everything.
   */
  "tool_failed",
  /**
   * A mini-tool that works on the sound was given a video without one. The
   * same file fails the same way, so running it again is not what is next.
   */
  "no_audio_track",
  /**
   * A transcription stopped at the length it may write before it was done.
   * Nothing of it is put on the node: a transcript that ends early reads as
   * a whole one.
   */
  "cut_short",
  /**
   * No upstream here takes the run as it was set up (#1521): the sentence
   * names the model and, when the refusal states one, the limit it broke.
   */
  "input_refused",
  /** No upstream of the model has its key on this deployment; the sentence names the variables. */
  "model_not_configured",
  /**
   * The account's own key for an upstream failed there (inner#1953): turned down, out of balance, without the model
   * or rate limited. The sentence names the upstream and why, so the user knows which key to top up or change.
   */
  "account_key_failed",
  /** The account's key the run held was replaced or deleted (inner#1953); our key is never used instead. */
  "account_key_missing",
  /** The upstream an account's key runs on could not be reached, or kept failing (inner#1953). */
  "upstream_unavailable",
] as const;

/** How a run on an account's own key failed (inner#1953): its key, its key row, or the upstream it runs on. */
export const ACCOUNT_KEY_FAILURE_KINDS = ["account_key_failed", "account_key_missing", "upstream_unavailable"] as const satisfies readonly TaskFailureReason[];

/** One of the kinds above. */
export type AccountKeyFailureKind = (typeof ACCOUNT_KEY_FAILURE_KINDS)[number];

/** Why an upstream turned an account's own key down (inner#1953). */
export const ACCOUNT_KEY_FAILURE_REASONS = ["invalid", "no_balance", "model_not_found", "rate_limited"] as const;

/** One of the reasons above. */
export type AccountKeyFailureReason = (typeof ACCOUNT_KEY_FAILURE_REASONS)[number];

/** One of the causes above. */
export type TaskFailureReason = (typeof TASK_FAILURE_REASONS)[number];

/**
 * The cause each stored code is told to the user as.
 *
 * There are more codes than causes on purpose. An operator has to tell R2
 * refusing the bytes from the parts refusing to assemble; a person reading
 * the node has the same thing to do either way, and a list of our internals
 * is not what they came for. So the log keeps the code and the user gets
 * the cause.
 *
 * A code absent from here reaches the user as itself, in every language —
 * which is what `task-failure.test.ts` holds every lane's codes against.
 */
const CAUSE_OF: ReadonlyMap<string, TaskFailureReason> = new Map([
  ...TASK_FAILURE_REASONS.map((r) => [r, r] as const),
  // Read off the codes themselves, and left uncast: a code added to
  // INGEST_FAILURE_CODES with no cause here widens this Map's value type and
  // stops compiling. The four named below are held by the test instead, which
  // walks INGEST_SETTLEMENT_CODES rather than a list typed beside it.
  [INGEST_NO_ANSWER, "internal"],
  [INGEST_REFUSED_UNNAMED, "internal"],
  [INGEST_TYPE_NOT_REPORTED, "internal"],
  [INGEST_NOT_STARTED, "internal"],
  ...INGEST_FAILURE_CODES.map(
    (code) =>
      [
        code,
        // The Worker's own names for what our side did; the other three
        // describe the address, and are causes in their own right.
        code === "store_failed" ||
        code === "assemble_failed" ||
        code === "upright_failed" ||
        code === "reader_not_started"
          ? "internal"
          : code,
      ] as const,
  ),
]);

/**
 * What a stored failure says about the file it was about.
 *
 * A cause on its own leaves the user asking which of their files this
 * happened to and what it was that we would not take. Both are known where
 * the failure is raised — the run holds the address it was handed and the
 * type it judged, and the browser's own gate holds the same two — so they
 * travel with the cause rather than being looked up again by a surface that
 * cannot reach them (user 2026-09-20).
 */
export type TaskFailureDetail = {
  /** What the file is called: its storage key's last segment. */
  file?: string;
  /** The type it was judged as, as the word a user uses for that format. */
  type?: string;
  /** How many bytes it is, for a cause that refused it over a ceiling. */
  bytes?: number;
  /**
   * Which reading failed, when it was not an understanding: the sentence
   * names the act the user asked for, on the row and in the history alike.
   */
  reading?: "transcribe";
  /** What the user knows the model as, for a cause about the model. */
  model?: string;
  /** The limit a refused input broke, when the refusal states one. */
  limit?: InputLimitShape;
  /** The environment variables a deployment is missing. */
  envVars?: string[];
  /** The upstream an account's key failed on or could not reach (inner#1953). */
  upstream?: string;
  /** Why that upstream turned the account's key down. */
  keyReason?: AccountKeyFailureReason;
  /**
   * The account whose key it was, so a viewer is told it was their own key, the current Studio Admin's or neither,
   * after the Studio changes hands too.
   */
  keyOwner?: string;
};

/** A stored failure, read back; a type rather than an interface, so it reads as a plain record of its fields. */
export type StoredTaskFailure = TaskFailureDetail & {
  /** The cause, or null when the stored text is not one of ours. */
  reason: TaskFailureReason | null;
};

/**
 * Write a cause and what it was about as one stored value.
 *
 * A cause with nothing to add stays the bare code it has always been, so
 * every row already written and every lane that writes one reads back the
 * same way.
 * @param reason - The cause the row holds, from the vocabulary above.
 * @param about - What is known about the file it happened to.
 * @returns What to store in `error_message`.
 */
export function encodeTaskFailure(
  reason: TaskFailureReason,
  about: TaskFailureDetail = {},
): string {
  const detail: TaskFailureDetail = {
    ...(about.file !== undefined && about.file !== "" && { file: about.file }),
    ...(about.type !== undefined && about.type !== "" && { type: about.type }),
    ...(Number.isFinite(about.bytes) && { bytes: about.bytes }),
    ...(about.reading === "transcribe" && { reading: about.reading }),
    ...(about.model !== undefined && about.model !== "" && { model: about.model }),
    ...(about.limit !== undefined && { limit: about.limit }),
    ...(about.envVars !== undefined && about.envVars.length > 0 && { envVars: about.envVars }),
    ...(about.upstream !== undefined && about.upstream !== "" && { upstream: about.upstream }),
    ...(isKeyReason(about.keyReason) && { keyReason: about.keyReason }),
    ...(about.keyOwner !== undefined && about.keyOwner !== "" && { keyOwner: about.keyOwner }),
  };
  return Object.keys(detail).length === 0
    ? reason
    : JSON.stringify({ reason, ...detail });
}

/**
 * Read a stored `error_message` as a cause and what it was about.
 * @param message - What the row holds, or null.
 * @returns The cause and its detail; the cause is null when this is not ours.
 */
export function readTaskFailure(message: string | null): StoredTaskFailure {
  if (message === null) return { reason: null };
  // A bare code is every row written before a cause had anything to add, and
  // every cause that still has nothing.
  if (!message.startsWith("{")) {
    return { reason: CAUSE_OF.get(message) ?? null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // A provider whose own error text happens to open with a brace. It is
    // what that provider said, and it travels as itself.
    return { reason: null };
  }
  // No text that opens with a brace and parses reaches here as anything but
  // an object, so this returns for nothing the product writes. It stays
  // because the line below reads fields off the result, and the day a second
  // caller reaches this function without the brace check above, `null.reason`
  // is what it would throw.
  if (typeof parsed !== "object" || parsed === null) return { reason: null };
  const held = parsed as Record<string, unknown>;
  const reason = typeof held.reason === "string" ? held.reason : "";
  return {
    reason: CAUSE_OF.get(reason) ?? null,
    ...(typeof held.file === "string" && { file: held.file }),
    ...(typeof held.type === "string" && { type: held.type }),
    ...(typeof held.bytes === "number" && { bytes: held.bytes }),
    ...(held.reading === "transcribe" && { reading: "transcribe" as const }),
    ...(typeof held.model === "string" && held.model !== "" && { model: held.model }),
    ...(isLimit(held.limit) && { limit: held.limit }),
    ...(Array.isArray(held.envVars) && held.envVars.length > 0 && held.envVars.every((v) => typeof v === "string") && { envVars: held.envVars }),
    ...(typeof held.upstream === "string" && held.upstream !== "" && { upstream: held.upstream }),
    ...(isKeyReason(held.keyReason) && { keyReason: held.keyReason }),
    ...(typeof held.keyOwner === "string" && held.keyOwner !== "" && { keyOwner: held.keyOwner }),
  };
}

/**
 * Whether a stored value is one of the reasons an upstream turns an account's key down.
 * @param value - What the row held; anything.
 * @returns True for one of ours.
 */
function isKeyReason(value: unknown): value is AccountKeyFailureReason {
  return (ACCOUNT_KEY_FAILURE_REASONS as readonly unknown[]).includes(value);
}

/**
 * Whether a stored value is an input limit as provider states one.
 * @param value - What the row held; anything.
 * @returns True for a limit with a field, a known measure and exactly one bound.
 * @throws {never} Never.
 */
function isLimit(value: unknown): value is InputLimitShape {
  if (typeof value !== "object" || value === null) return false;
  const l = value as Record<string, unknown>;
  /**
   * Whether one bound is absent or a count.
   * @param n - The stored bound.
   * @returns True for undefined or a non-negative integer.
   */
  const bound = (n: unknown): boolean => n === undefined || (typeof n === "number" && Number.isInteger(n) && n >= 0);
  return typeof l.field === "string"
    && (l.measure === "characters" || l.measure === "lines" || l.measure === "chinese_characters")
    && bound(l.max) && bound(l.min) && ((l.max === undefined) !== (l.min === undefined))
    && (l.per === undefined || l.per === "line" || l.per === "item");
}

