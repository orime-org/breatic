// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions endpoint, as one request and one reading of its answer.
 *
 * Built the way `understand.ts:271-291` builds its own vendor call -- the
 * deadline as a parameter, the body read here, the caller's stop passed
 * through -- because that one sits on the same vendor and the same key.
 *
 * Every answer key carries its own `type`, so every key is checked alone.
 * One key the endpoint phrased in a shape we cannot read says nothing about
 * the keys beside it, and the model asking three questions at once is what
 * this endpoint is for.
 */

import { FAILURE_LINES, httpRequest, readWithin, reasonOf } from "@breatic/shared";
import type { FailureVoice, NextMove } from "@domain/agent/tools/failure.js";
import {
  isStop,
  nextMovesFor,
  reason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";

/** One question, in whichever of the three shapes the model chose. */
export type JevQuestion = Readonly<Record<string, unknown>>;

/** What one call needs. */
export interface JevRequest {
  /** Where the decisions endpoint lives. */
  readonly url: string;
  /** The key, which only ever travels in a header. */
  readonly apiKey: string;
  /** Which model answers. */
  readonly model: string;
  /** Whatever the model is holding, in whatever shape it holds it. */
  readonly state: unknown;
  /** The questions, by the keys the model chose for them. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /** How long one delivery may take, and how long its body may take. */
  readonly budgetMs: number;
  /** How the calling tool names what it does, for the failure sentences. */
  readonly voice: FailureVoice;
  /** The reader's stop, when the caller has one. */
  readonly abortSignal?: AbortSignal;
}

/** What the tool hands back: the keys that read, and the keys that did not. */
export interface JevAnswers {
  /** Each key the endpoint answered, exactly as it answered it. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The keys whose answer we could not read, by name. */
  readonly unreadable: readonly string[];
}

/**
 * Whether a value is a probability.
 * @param value - The value to judge.
 * @returns True when it is a number within zero and one.
 */
function isProbability(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Whether every value of an object is a probability.
 * @param value - The object to judge.
 * @returns True when it is an object and all of its values are probabilities.
 */
function holdsProbabilities(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(isProbability);
}

/**
 * Whether one answer holds what the type it declares is supposed to hold.
 *
 * `noul` carries no confidence, which is the endpoint's shape rather than an
 * omission: it answers one probability and that probability is the whole of
 * what it knows.
 * @param answer - One value of the `answers` object.
 * @returns True when the answer can be read.
 */
function readsAsItsType(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const held = answer as Record<string, unknown>;
  switch (held["type"]) {
    case "noul":
      return isProbability(held["noul"]);
    case "choice":
      return (
        typeof held["choice"] === "string" &&
        holdsProbabilities(held["probabilities"]) &&
        isProbability(held["confidence"])
      );
    case "score":
      return (
        typeof held["score"] === "number" &&
        Number.isFinite(held["score"]) &&
        typeof held["legend"] === "object" &&
        held["legend"] !== null &&
        holdsProbabilities(held["probabilities"]) &&
        isProbability(held["confidence"])
      );
    default:
      return false;
  }
}

/**
 * Split an answered object into the keys that read and the keys that did not.
 * @param answered - The `answers` object as it arrived.
 * @returns Both halves.
 */
function splitByReadable(answered: Record<string, unknown>): JevAnswers {
  const answers: Record<string, Record<string, unknown>> = {};
  const unreadable: string[] = [];
  for (const [key, value] of Object.entries(answered)) {
    if (readsAsItsType(value)) answers[key] = value as Record<string, unknown>;
    else unreadable.push(key);
  }
  return { answers, unreadable };
}

/**
 * Put one set of questions to the endpoint and read what comes back.
 * @param request - Everything the call needs.
 * @returns The keys that read, and the names of the keys that did not.
 * @throws {Error} Carrying tool failure detail, or the reader's stop.
 */
export async function askJev(request: JevRequest): Promise<JevAnswers> {
  const { url, apiKey, model, state, questions, budgetMs, voice, abortSignal } = request;
  const moves = nextMovesFor(voice);

  let res: Response;
  try {
    // The deadline goes in as `timeoutMs` rather than as a signal on the init:
    // the transport replaces the caller's signal, so one left there would be a
    // no-op and the call would silently take the transport's five-minute
    // default instead. `replaySafe: false` because a judgement that took three
    // deliveries to arrive is one the turn no longer has a use for -- the
    // reader is waiting, and the model is better off failing and deciding on
    // what it already holds.
    res = await httpRequest(
      url,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, state, questions }),
      },
      {
        replaySafe: false,
        timeoutMs: budgetMs,
        ...(abortSignal ? { signal: abortSignal } : {}),
      },
    );
  } catch (err: unknown) {
    if (isStop(err, abortSignal)) throw stoppedByUser();
    // Nothing answered. The transport's own sentence names a redacted address
    // and an attempt count, neither of which tells the model anything it can
    // act on, so what it reads is this instead.
    throw toolFailed(
      reason(`Nothing answered the ${voice.act} request: ${reasonOf(err)}.`, moves.retryOnce),
      FAILURE_LINES.unreachable,
    );
  }

  if (!res.ok) {
    // A body nobody reads keeps its connection out of the pool. Discarding the
    // promise is safe only while nothing awaits between the transport handing
    // this response back and this line.
    void res.body?.cancel();
    throw toolFailed(
      reason(refusalKind(res.status, voice), refusalMove(res.status, moves)),
      FAILURE_LINES.upstream,
    );
  }

  let text: string;
  try {
    text = await readWithin(res, budgetMs, abortSignal);
  } catch (err: unknown) {
    // Asked here rather than left to the caller's guard, which never sees
    // this: that guard passes anything carrying failure detail straight
    // through, past the question of whether the user stopped.
    if (isStop(err, abortSignal)) throw stoppedByUser();
    throw toolFailed(
      reason(`The ${voice.act} answer could not be read: ${reasonOf(err)}.`, moves.retryOnce),
      FAILURE_LINES.upstream,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw toolFailed(
      reason(`The ${voice.act} service answered something that is not ours.`, moves.stop),
      FAILURE_LINES.upstream,
    );
  }

  const answered = (body as { answers?: unknown }).answers;
  const split =
    typeof answered === "object" && answered !== null
      ? splitByReadable(answered as Record<string, unknown>)
      : { answers: {}, unreadable: [] };

  if (Object.keys(split.answers).length === 0) {
    throw toolFailed(
      reason(`The ${voice.act} service answered, and none of it could be read.`, moves.stop),
      FAILURE_LINES.upstream,
    );
  }
  return split;
}

/**
 * What kind of refusal this was, in words the model can act on.
 *
 * A status code alone tells the model that something said no. Which kind of
 * no it was decides what happens next -- a rate limit clears, a rejected key
 * does not -- so the sentence names the kind rather than the number.
 * @param status - The status the service answered with.
 * @param voice - How the calling tool names what it does.
 * @returns One sentence, ending in a full stop.
 */
function refusalKind(status: number, voice: FailureVoice): string {
  if (status === 429) return `The ${voice.act} service is rate limiting us.`;
  if (status === 401 || status === 403) {
    return `The ${voice.act} service rejected our credentials.`;
  }
  if (status >= 500) return `The ${voice.act} service is having trouble of its own.`;
  return `The ${voice.act} service turned the request down (${String(status)}).`;
}

/**
 * What the model may do about a refusal, by what kind of refusal it was.
 *
 * A rate limit clears on its own and a rejected key does not, so the two do
 * not share a move: telling the model to try again on a revoked key spends a
 * second call to learn the same thing.
 * @param status - The status the service answered with.
 * @param moves - The moves phrased for this tool.
 * @returns The one move that fits.
 */
function refusalMove(status: number, moves: ReturnType<typeof nextMovesFor>): NextMove {
  if (status === 429) return moves.retryOnce;
  if (status >= 500) return moves.retryOnce;
  return moves.stop;
}
