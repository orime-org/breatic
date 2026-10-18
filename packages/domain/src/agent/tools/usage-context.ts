// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool that spends money is handed alongside its input (#296).
 *
 * The turn passes its usage recorder through the SDK's `toolsContext`, and a
 * paying tool declares this schema as its `contextSchema`. The SDK validates
 * the context before `execute` runs, so a caller that forgot to pass a
 * recorder gets a failed call rather than an unrecorded one.
 */

import { z } from "zod";

import type { UsageRecorder } from "@domain/credit/usage-recorder.js";

/** The context a paying tool reads. */
export interface UsageContext extends Record<string, unknown> {
  usage: UsageRecorder;
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

/** The `contextSchema` every paying tool declares. */
export const usageContextSchema: z.ZodType<UsageContext> = z.object({
  usage: z.custom<UsageRecorder>(isRecorder, "a usage recorder"),
});

/**
 * The `toolsContext` for a tool set: every tool gets the same recorder.
 *
 * Keyed by every tool in the set rather than by a list of the paying ones, so
 * a tool that starts paying needs no second place updated; a tool that does
 * not declare the schema ignores what it is handed.
 * @param tools - The tool set the call will run with.
 * @param usage - The operation's recorder.
 * @returns The context, by tool name.
 */
export function usageContextFor(
  tools: Readonly<Record<string, unknown>>,
  usage: UsageRecorder,
): Record<string, UsageContext> {
  return Object.fromEntries(Object.keys(tools).map((name) => [name, { usage }]));
}
