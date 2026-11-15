// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { InputLimit, RejectedInput } from "@breatic/provider";

/**
 * The words for an upstream's limit, as the model reads them.
 * @param limit - The limit.
 * @returns E.g. "at most 100 lines in the prompt".
 * @throws {never} Never.
 */
function limitWords(limit: InputLimit): string {
  const field = limit.field === "prompt" ? "the prompt" : `"${limit.field}"`;
  const bound = limit.max !== undefined ? `at most ${String(limit.max)}` : `at least ${String(limit.min)}`;
  if (limit.measure === "lines") return `${bound} lines in ${field}`;
  if (limit.measure === "chinese_characters") return `${bound} Chinese characters in ${field}`;
  const where = limit.per === "line" ? `each line of ${field}` : limit.per === "item" ? `each item of ${field}` : field;
  return `${bound} characters in ${where}`;
}

/**
 * The refusal of a generation no upstream here takes (#1521): the limit it breaks, in the upstream's words too.
 * @param name - What the proposal calls the generation.
 * @param model - Its model.
 * @param refusal - The refusal of the first upstream its route would try.
 * @returns The reason the answer gives.
 * @throws {never} Never.
 */
export function upstreamRefusal(name: string, model: string, refusal: RejectedInput): string {
  const said = "param" in refusal ? `it does not take ${refusal.param} = ${JSON.stringify(refusal.value)}` : refusal.reason;
  const limit = "limit" in refusal && refusal.limit !== undefined ? ` "${model}" takes ${limitWords(refusal.limit)} here.` : "";
  return `"${name}" breaks a limit of every upstream that serves "${model}" here.${limit} The upstream says: ${said}.`;
}
