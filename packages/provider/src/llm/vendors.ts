// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How each LLM upstream kind is reached and spoken to. Each vendor takes reasoning, caching and a sticky session
 * its own way, under the key its AI SDK provider reads `providerOptions` by.
 * Reasoning is stated in both directions because leaving it out means
 * something different to each vendor; Claude, on either route, gets nothing
 * when it is off, the one spelling every Claude version accepts.
 */

import type { CallWants } from "@provider/llm/api.js";
import { anthropic } from "@provider/llm/upstreams/anthropic.js";
import { isClaude, type Vendor, type VendorOptions } from "@provider/llm/upstreams/common.js";
import { deepseek } from "@provider/llm/upstreams/deepseek.js";
import { google } from "@provider/llm/upstreams/google.js";
import { openai } from "@provider/llm/upstreams/openai.js";
import { openrouter } from "@provider/llm/upstreams/openrouter.js";

export { isClaude, messageOf, type ModelV4, type Refusal, type ReportedCosts, type Vendor, type VendorOptions } from "@provider/llm/upstreams/common.js";

/**
 * The status an error part before content stands for, read the answering vendor's way:
 * a value carrying a numeric statusCode (the stream errors the DeepSeek and
 * OpenAI-compatible SDKs build, plain objects or Errors), else the vendor's own plain form.
 * @param vendor - The vendor that answered.
 * @param error - What the error part carried.
 * @returns The status, or undefined when the part says none.
 */
export function inBandStatusOf(vendor: Vendor | undefined, error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null | undefined)?.statusCode;
  if (typeof status === "number" && Number.isInteger(status)) return status;
  return error instanceof Error ? undefined : vendor?.inBandStatus?.(error);
}

/**
 * The body a vendor's refusal is read from for an error part.
 * @param error - What the error part carried.
 * @returns The SDK's own chunk when its stream error kept one, else `{ error }`.
 */
export function inBandBodyOf(error: unknown): unknown {
  return (error as { data?: unknown } | null | undefined)?.data ?? { error };
}

/** Every LLM adapter, by the upstream kind it speaks to. */
const VENDORS: Readonly<Record<string, Vendor>> = { anthropic, google, openai, deepseek, openrouter };

/**
 * The vendor of an upstream kind.
 * @param kind - The upstream's kind.
 * @returns How it is spoken to.
 * @throws {Error} When provider has no LLM adapter of that kind.
 */
export function vendorOf(kind: string): Vendor {
  if (!hasLlmAdapter(kind)) throw new Error(`No LLM adapter speaks to upstreams of kind "${kind}"`);
  return VENDORS[kind]!;
}

/**
 * Whether an LLM adapter speaks to upstreams of a kind.
 * @param kind - The upstream kind, as the configuration names it.
 * @returns True when one does.
 */
export function hasLlmAdapter(kind: string): boolean {
  return Object.hasOwn(VENDORS, kind);
}

/**
 * The cache mark this vendor puts on a call, or nothing.
 * @param vendor - The vendor.
 * @param modelId - Our model id.
 * @param cache - The lifetime asked for, or false.
 * @returns The mark.
 */
export function cacheMark(vendor: Vendor, modelId: string, cache: CallWants["cache"]): VendorOptions {
  return cache === false ? {} : vendor.cache(modelId, cache);
}

/**
 * What one vendor is sent so the call reasons, or does not, caches, or does not,
 * and stays on one backend for a conversation.
 * @param vendor - The vendor.
 * @param modelId - Our model id.
 * @param wants - What the call asks for.
 * @returns The vendor's options.
 */
export function optionsFor(vendor: Vendor, modelId: string, wants: CallWants): VendorOptions {
  const level = wants.thinkingLevel;
  const reasoning = wants.thinking
    ? level !== undefined && vendor.reasoning.at !== undefined ? vendor.reasoning.at(level) : vendor.reasoning.on(modelId)
    : isClaude(modelId) ? {} : vendor.reasoning.off;
  const session: VendorOptions = wants.session !== undefined && vendor.gateway ? { session_id: wants.session } : {};
  return { ...reasoning, ...cacheMark(vendor, modelId, wants.cache), ...session };
}
