// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request body one WaveSpeed endpoint receives, built from the model's own
 * declarations: the yaml names each param's upstream field, so this is the one
 * place our names become the endpoint's.
 */

import type { FullModelEntry } from "@breatic/domain";

/**
 * Whether a value carries something to send.
 * @param value - A param's value after validation.
 * @returns False for nothing, an empty string and an empty list.
 */
function carries(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

/**
 * Builds the upstream request body for one run.
 * @param entry - The model's catalog entry.
 * @param params - The run's params under our names, validated and defaulted.
 * @param prompt - The prompt as the model's family formatted it.
 * @param consumed - Params the model's family reads itself and keeps off the wire.
 * @returns The body, keyed by the endpoint's field names.
 */
export function upstreamBody(
  entry: FullModelEntry,
  params: Readonly<Record<string, unknown>>,
  prompt: string,
  consumed: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(entry.params ?? {})) {
    if (consumed.has(name)) continue;
    const value = params[name];
    if (!carries(value)) continue;
    body[spec.upstream ?? name] = value;
  }
  if (entry.takes_prompt === true && prompt !== "") {
    body[entry.prompt_upstream ?? "prompt"] = prompt;
  }
  return body;
}
