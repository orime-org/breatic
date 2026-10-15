// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a reply row keeps of what was sent (inner#1549).
 *
 * A finished step's messages are what the SDK sent on with the next request,
 * and they are collected as each step ends. A turn stopped or broken off
 * inside a step never finishes it, so that step is put together here from
 * what had already reached the reader.
 */

import { convertToModelMessages, isToolUIPart } from "ai";
import type { DynamicToolUIPart, ModelMessage, ToolSet, ToolUIPart, UIMessage } from "ai";
import type { ToolFailure } from "@breatic/shared";

import { stripThinking } from "@server/agent/history-replay.js";

/** How the calls of the turn ended, as the turn recorded them. */
export interface SettledCalls {
  /** What a call answered, by call id. */
  answered: ReadonlyMap<string, unknown>;
  /** How a call that came back with nothing ended, by call id. */
  ended: ReadonlyMap<string, ToolFailure>;
}

type Part = UIMessage["parts"][number];

/**
 * A tool part with the ending the turn recorded for it.
 *
 * What went out on the wire for a failed call is one generic line; what the
 * model is told is the turn's own account of it.
 * @param part - The tool part.
 * @param settled - How the turn's calls ended.
 * @returns The part as it ended, or as it stood when nothing ended it.
 * @throws {never} Never.
 */
function settle(part: ToolUIPart | DynamicToolUIPart, settled: SettledCalls): Part {
  if (settled.answered.has(part.toolCallId)) {
    return { ...part, state: "output-available", output: settled.answered.get(part.toolCallId) } as Part;
  }
  const ended = settled.ended.get(part.toolCallId);
  if (ended !== undefined) return { ...part, state: "output-error", errorText: ended.forModel } as Part;
  return part;
}

/**
 * The tool call ids a run of messages holds.
 * @param messages - The messages.
 * @returns Their call ids.
 * @throws {never} Never.
 */
function callIdsIn(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if ("toolCallId" in part) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/**
 * The step a turn ended inside, as the model would have been sent it.
 *
 * The reply's parts open each step with a `step-start`; what follows the one
 * after the collected steps is the step in progress. Its thinking is left
 * out, being unfinished, and so is a call that never got an answer. When no
 * such `step-start` exists the turn stopped between steps, or the next
 * step's request failed before anything came back, and there is nothing to
 * add.
 * @param parts - The reply's parts, as the reader received them.
 * @param stepsDone - How many steps finished and were collected.
 * @param tools - The turn's tools, whose own conversion renders a result.
 * @param settled - How the turn's calls ended.
 * @param collected - The messages of the steps already collected.
 * @returns The step's messages, or none.
 * @throws {Error} When the SDK cannot convert the parts.
 */
export async function inProgressStep(
  parts: UIMessage["parts"],
  stepsDone: number,
  tools: ToolSet,
  settled: SettledCalls,
  collected: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  const at = parts.flatMap((part, i) => (part.type === "step-start" ? [i] : []))[stepsDone];
  if (at === undefined) return [];

  const step = parts.slice(at + 1).map((part) => (isToolUIPart(part) ? settle(part, settled) : part));
  // Without thinking: what it had of its own is unfinished, and a provider
  // can hang signed thinking on the step's tool call as well.
  const messages = stripThinking(
    await convertToModelMessages([{ role: "assistant", parts: step }], {
      tools,
      ignoreIncompleteToolCalls: true,
    }),
  );

  // A call already among the collected steps means the step count and the
  // parts disagree; sending the call twice is a request the provider refuses.
  const seen = callIdsIn(collected);
  return [...callIdsIn(messages)].some((id) => seen.has(id)) ? [] : messages;
}

/** What the provider reported about a turn's model calls. */
export interface ReportedUsage {
  /** Input tokens of the turn's first call. */
  firstInput?: number;
  /** Input tokens of its last call. */
  lastInput?: number;
  /** Output tokens of its last call. */
  lastOutput?: number;
}

/**
 * What the provider reported, with one more call's count added.
 *
 * A call that reported nothing leaves the counts as they were: a step that
 * broke off reports no usage, and the count an earlier call gave is still the
 * best figure there is.
 * @param reported - What earlier calls of the turn reported.
 * @param usage - What this call reported.
 * @param usage.inputTokens - Its input tokens, cache reads and writes included.
 * @param usage.outputTokens - Its output tokens.
 * @returns The counts with this call's added.
 * @throws {never} Never.
 */
export function noteUsage(
  reported: ReportedUsage,
  usage: { inputTokens: number | undefined; outputTokens: number | undefined },
): ReportedUsage {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return reported;
  return {
    firstInput: reported.firstInput ?? usage.inputTokens,
    lastInput: usage.inputTokens,
    lastOutput: usage.outputTokens,
  };
}

/** Character counts to fall back on when nothing was reported. */
export interface MeasuredChars {
  /** This turn's user message. */
  user: number;
  /** What the reply row keeps. */
  reply: number;
  /** The size of the first request, as the turn estimated it before sending. */
  request: number;
}

/**
 * How much the turn added to the conversation, and how big it ended.
 *
 * Both from the provider's own count, inputs including cache reads and
 * writes. A turn with no count -- its first call stopped or failed before
 * one came back -- is measured in characters, a character counted as a
 * token: never fewer than the tokens, so a fold can only come early.
 * @param usage - What the provider reported.
 * @param chars - Character counts to fall back on.
 * @returns The two figures the reply row keeps.
 * @throws {never} Never.
 */
export function replyTokens(
  usage: ReportedUsage,
  chars: MeasuredChars,
): { turnTokens: number; endTokens: number } {
  const { firstInput, lastInput, lastOutput } = usage;
  if (firstInput === undefined || lastInput === undefined || lastOutput === undefined) {
    return { turnTokens: chars.user + chars.reply, endTokens: chars.request + chars.reply };
  }
  const endTokens = lastInput + lastOutput;
  return { turnTokens: endTokens - firstInput + chars.user, endTokens };
}
