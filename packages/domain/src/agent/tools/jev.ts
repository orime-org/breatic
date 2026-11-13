// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The decisions endpoint, as one call to provider and one reading of its answer.
 *
 * Every answer key carries its own `type`, so every key is checked alone.
 * One key the endpoint phrased in a shape we cannot read says nothing about
 * the keys beside it, and the model asking three questions at once is what
 * this endpoint is for.
 */

import { FAILURE_LINES, reasonOf } from "@breatic/shared";
import { BilledAnswerLost, NoUpstreamAvailable, type Cost, type JudgeAnswer } from "@breatic/provider";
import { z } from "zod";

import { stripUnicodeTagsDeep } from "@domain/agent/strip-unicode-tags.js";
import { provider } from "@domain/provider/instance.js";
import type { FailureVoice } from "@domain/agent/tools/failure.js";
import {
  clip,
  failedWith,
  isStop,
  keepInside,
  nextMovesFor,
  notOurPayloadReason,
  onOneLine,
  readFailedReason,
  reason,
  refusalReason,
  stoppedByUser,
  toolFailed,
} from "@domain/agent/tools/failure.js";

/**
 * How this tool names what it does, in the sentences a failure carries.
 *
 * The fallback says what to do instead rather than what to announce: a
 * judgement is the model's own deliberation, and the user asked for the
 * work rather than for this.
 */
const voice: FailureVoice = {
  act: "judgement",
  results: "that judgement",
  retrying: "Asking once more",
  elsewhere: "decide from what you already hold",
  attempting: "Judging",
  fallback: "continue without that judgement and decide from what you already hold.",
};

/** The moves a failure of this tool points the model at. */
const moves = nextMovesFor(voice);

/**
 * The failure for a call that got no answer: nothing came back before the
 * budget ran out, or the delivery itself failed.
 * @param cause - What the transport threw.
 * @returns The error to throw.
 */
function unanswered(cause: unknown): Error {
  return toolFailed(
    reason(`Nothing answered the ${voice.act} request.`, moves.retryOnce),
    FAILURE_LINES.noConnection,
    cause,
  );
}

/** One question, in whichever of the three shapes the model chose. */
type JevQuestion = Readonly<Record<string, unknown>>;

/** What one call needs. */
interface JevRequest {
  /** Whatever the model is holding, in whatever shape it holds it. */
  readonly state: unknown;
  /** The questions, by the keys the model chose for them. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  /** How long the whole call may take, deliveries and backoffs together. */
  readonly budgetMs: number;
  /** The user's stop, when the caller has one. */
  readonly abortSignal?: AbortSignal;
  /**
   * Called once for an answer the endpoint billed: what it cost, who served
   * it, and the decisions model it was asked of. Before any judgement of the
   * answer, so an answer that cannot be read is still recorded.
   */
  readonly onBilled: (billed: { cost: Cost; upstream: string; model: string }) => void;
}

/** What the tool hands back: the keys that read, and the keys that did not. */
export interface JevAnswers {
  /** Each key the endpoint answered, exactly as it answered it. */
  readonly answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The keys whose answer we could not read, by name. */
  readonly unreadable: readonly string[];
}

/** A number the endpoint means as a probability. */
const probability = z.number().min(0).max(1);

/**
 * One answer of each type, in the shape the endpoint sends it.
 *
 * `noul` carries no confidence, which is the endpoint's shape rather than an
 * omission: it answers one probability and that probability is the whole of
 * what it knows. What this settles is whether the model can read the key --
 * where a score falls within its own legend is the endpoint's answer, and the
 * legend arrives beside it for the model to read.
 */
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), probability),
    confidence: probability,
  }),
]);

/**
 * Sort the asked keys into the ones that came back readable and the rest.
 *
 * Walks what was asked rather than what came back, so a question the endpoint
 * skipped is named in `unreadable` instead of vanishing. What goes into
 * `answers` is the value as it arrived, not what the schema parsed out of it:
 * the schema settles whether the model can read the key, and a field this side
 * has not heard of is still the vendor's answer.
 * @param asked - The keys the model asked under.
 * @param answered - The `answers` object as it arrived.
 * @returns Both halves.
 */
function sortByReadable(asked: readonly string[], answered: Record<string, unknown>): JevAnswers {
  const answers: Record<string, Record<string, unknown>> = {};
  const unreadable: string[] = [];
  for (const key of asked) {
    const value = answered[key];
    if (answerSchema.safeParse(value).success) answers[key] = value as Record<string, unknown>;
    else unreadable.push(key);
  }
  return { answers, unreadable };
}

/**
 * Read the answered keys off a response body.
 * @param text - The body as it arrived.
 * @param asked - The keys the model asked under.
 * @returns Both halves, or null when the body is not an answer at all.
 */
function readAnswers(text: string, asked: readonly string[]): JevAnswers | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  // `JSON.parse` answers `null` for the literal, and reading a field off that
  // throws a bare TypeError -- which reaches the model as the SDK's "Correct
  // the call and try once more", sending it to rewrite a call that was fine.
  if (typeof body !== "object" || body === null) return null;
  const answered = (body as { answers?: unknown }).answers;
  if (typeof answered !== "object" || answered === null) return null;
  return sortByReadable(asked, answered as Record<string, unknown>);
}

/**
 * What the endpoint said it would not take, in its own words.
 *
 * Read off a refusal because it names the field it refused -- measured,
 * `path:["questions","a","criteria"] expected array` for a scale given a map,
 * and `Choice question must have at least one choice: <key>` for an empty
 * option set. The model wrote the request and is the one that can rewrite it.
 *
 * Only `error.message` travels. The body also carries `user_id`, which is who
 * we are to the vendor and says nothing the model can act on.
 * @param body - The refusal's body as provider read it.
 * @returns The complaint, or an empty string when there is none to read.
 */
function complaintOf(body: string): string {
  let said: unknown;
  try {
    said = JSON.parse(body);
  } catch {
    return "";
  }
  if (typeof said !== "object" || said === null) return "";
  const message = (said as { error?: { message?: unknown } }).error?.message;
  return typeof message === "string" ? clip(keepInside(onOneLine(message)), 400) : "";
}

/**
 * The billed answer an error says was lost, when it says one was.
 * @param err - What the call threw.
 * @returns The lost answer, carrying its cost and who served it.
 */
function lostAnswerOf(err: unknown): BilledAnswerLost | undefined {
  for (let current = err; current instanceof Error; current = current.cause) {
    if (current instanceof BilledAnswerLost) return current;
  }
  return undefined;
}

/**
 * Put one set of questions to the endpoint and read what comes back.
 * @param request - Everything the call needs.
 * @returns The keys that read, and the names of the keys that did not.
 * @throws {Error} Carrying tool failure detail, or the user's stop.
 */
export async function askJev(request: JevRequest): Promise<JevAnswers> {
  const { budgetMs, abortSignal, onBilled } = request;
  // Cleaned here as well as by provider: the endpoint answers under the names
  // it was sent, so the answers are read against these same names.
  const { state, questions } = stripUnicodeTagsDeep({
    state: request.state,
    questions: request.questions,
  });
  // The keys are the model's own words, and every sentence below is stored on
  // the call and read again by every later turn -- the same treatment the
  // search tools give a query before it reaches one.
  const asked = clip(keepInside(onOneLine(Object.keys(questions).join(", "))), 200);
  const startedAt = Date.now();

  let answer: JudgeAnswer;
  try {
    // The budget bounds the whole call, deliveries and the body together;
    // provider sends it once, with no replay.
    answer = await provider().llm.judge({
      state,
      questions,
      budgetMs: Math.trunc(budgetMs),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
  } catch (err: unknown) {
    const lost = lostAnswerOf(err);
    if (lost?.served !== undefined) onBilled({ cost: lost.costs[0]!, ...lost.served });
    if (isStop(err, abortSignal)) throw stoppedByUser();
    if (err instanceof NoUpstreamAvailable) {
      throw toolFailed(
        "Judgement is not available on this deployment: it has no credentials. Tell the user, and do not try again.",
        FAILURE_LINES.unavailable,
        err,
      );
    }
    // A billed answer whose body stopped inside the budget is a read that
    // failed; one that ran the budget out is the same fact as nothing
    // answering at all, and says so.
    if (lost !== undefined && Date.now() - startedAt < budgetMs) {
      throw failedWith(readFailedReason(voice, asked, reasonOf(err)));
    }
    // The transport's own sentence names the address it was given. That is
    // our vendor's identity, it tells the model nothing it can act on, and it
    // is read again by every later turn off the stored row -- so what the
    // model gets is the fact instead.
    throw unanswered(err);
  }

  if (answer.status < 200 || answer.status > 299) {
    // A stop that landed mid-refusal arrives here looking like an upstream
    // fault. What the user did outranks what the service said.
    if (abortSignal?.aborted === true) throw stoppedByUser();
    const complaint = complaintOf(answer.body);
    // Which of the two this is, the status cannot always say. The model
    // composed this body, so a 422 -- which the shared table reads as a fault
    // in our configuration -- is one it may compose again. And a refusal that
    // names the decisions model is our doing whichever 4xx it answers:
    // measured, an unknown name answers 400, the same as a malformed question.
    // Three answers, not two: this side knows about exactly two statuses, and
    // every other one is the shared table's to sort.
    const rewordable = complaint.includes(answer.model)
      ? false
      : answer.status === 422
        ? true
        : undefined;
    throw failedWith(refusalReason(voice, asked, answer.status, complaint, rewordable));
  }

  onBilled({
    cost: answer.cost ?? { state: "missing", reason: "the decisions endpoint answered no cost" },
    upstream: answer.upstream,
    model: answer.model,
  });

  const split = readAnswers(answer.body, Object.keys(questions));
  if (split === null) {
    throw failedWith(notOurPayloadReason(voice, asked));
  }
  // Every key unreadable is the same fact as one of them being unreadable, and
  // A4's answer to it is the same: the names travel and the model decides.
  return split;
}
