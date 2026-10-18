// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool that spends money is handed alongside its input (#296).
 *
 * The turn passes its usage recorder through the SDK's `toolsContext`, and a
 * paying tool declares this schema as its `contextSchema`. The SDK validates
 * the context before `execute` runs, so a caller that forgot to pass a
 * recorder gets a failed call rather than an unrecorded one.
 *
 * A turn that holds credits for its work (inner#1611) passes its hold as well,
 * and a paying tool grows it by its own estimate before it spends.
 */

import { z } from "zod";

import { env, getAgentConfig, getUsagePricing } from "@breatic/core";
import { FAILURE_LINES } from "@breatic/shared";
import { toolFailed } from "@domain/agent/tools/failure.js";
import { creditsForUsd } from "@domain/credit/usage-cost.js";
import type { UsageRecorder } from "@domain/credit/usage-recorder.js";

/** The tools that spend money, as the hold sizes them. */
export type PaidTool = "web_search" | "search_images" | "understand_media" | "judge_likelihood";

/**
 * What a paying tool holds before it runs (inner#1611): the Brave searches
 * their per-request price, the others the figure `agent.yaml` gives them,
 * because their price is known only once the call is over.
 * @param tool - The tool.
 * @returns Credits.
 */
export function paidToolHoldCredits(tool: PaidTool): number {
  const { services } = getUsagePricing();
  if (tool === "web_search") return creditsForUsd(services.brave_web_search.per_request, env.CREDIT_MULTIPLIER);
  if (tool === "search_images") return creditsForUsd(services.brave_image_search.per_request, env.CREDIT_MULTIPLIER);
  return getAgentConfig().paid_tool_hold_credits[tool];
}

/** The part of a turn's credit hold a tool can grow. */
export interface ToolHold {
  /**
   * Grow the turn's hold by a tool's estimate.
   * @returns Whether it grew; false when the studio cannot cover it.
   */
  extend(credits: number): Promise<boolean>;
}

/** The context a paying tool reads. */
export interface UsageContext extends Record<string, unknown> {
  usage: UsageRecorder;
  /** The turn's credit hold; absent for a run that holds nothing. */
  hold?: ToolHold;
}

/**
 * Whether a value can stand as a recorder.
 * @param value - What the caller put in the context.
 * @returns True when it has the two recording methods.
 */
function isRecorder(value: unknown): value is UsageRecorder {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UsageRecorder>;
  return (
    typeof candidate.recordServiceCall === "function" &&
    typeof candidate.recordModelCall === "function"
  );
}

/**
 * Whether a value can stand as a hold.
 * @param value - What the caller put in the context.
 * @returns True when it can be extended.
 */
function isHold(value: unknown): value is ToolHold {
  return typeof value === "object" && value !== null && typeof (value as Partial<ToolHold>).extend === "function";
}

/** The `contextSchema` every paying tool declares. */
export const usageContextSchema: z.ZodType<UsageContext> = z.object({
  usage: z.custom<UsageRecorder>(isRecorder, "a usage recorder"),
  hold: z.custom<ToolHold>(isHold, "a credit hold").optional(),
});

/**
 * Hold a paying tool's estimate before it spends, or refuse the call.
 *
 * The refusal tells the model the studio cannot cover the call, so it can say
 * so; the reader sees the credits line.
 * @param context - The tool's context.
 * @param credits - What the call may cost.
 * @throws {Error} A tool failure when the studio cannot cover it.
 */
export async function holdForTool(context: UsageContext, credits: number): Promise<void> {
  if (!context.hold) return;
  if (await context.hold.extend(credits)) return;
  throw toolFailed(
    "This studio does not have enough credits for this call, so it was not made. Tell the user they need more credits for it.",
    FAILURE_LINES.credits,
  );
}

/**
 * The `toolsContext` for a tool set: every tool gets the same recorder and hold.
 *
 * Keyed by every tool in the set rather than by a list of the paying ones, so
 * a tool that starts paying needs no second place updated; a tool that does
 * not declare the schema ignores what it is handed.
 * @param tools - The tool set the call will run with.
 * @param usage - The operation's recorder.
 * @param hold - The operation's credit hold, when it holds credits.
 * @returns The context, by tool name.
 */
export function usageContextFor(
  tools: Readonly<Record<string, unknown>>,
  usage: UsageRecorder,
  hold?: ToolHold,
): Record<string, UsageContext> {
  return Object.fromEntries(Object.keys(tools).map((name) => [name, hold ? { usage, hold } : { usage }]));
}
