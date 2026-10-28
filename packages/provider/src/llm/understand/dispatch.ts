// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { UnderstandAdapter } from "@provider/llm/understand/adapter.js";
import { googleUnderstand } from "@provider/llm/understand/google.js";
import { openRouterUnderstand } from "@provider/llm/understand/openrouter.js";

const ADAPTERS: Readonly<Record<string, UnderstandAdapter>> = { google: googleUnderstand, openrouter: openRouterUnderstand };

/**
 * Whether provider reads media through upstreams of a kind.
 * @param kind - The upstream's kind.
 * @returns True when an understand adapter speaks to it.
 */
export function hasUnderstandAdapter(kind: string): boolean {
  return ADAPTERS[kind] !== undefined;
}

/**
 * The understand adapter of an upstream kind.
 * @param kind - The upstream's kind.
 * @returns Its adapter.
 * @throws {Error} When provider reads no media through upstreams of that kind.
 */
export function understandAdapterOf(kind: string): UnderstandAdapter {
  const adapter = ADAPTERS[kind];
  if (adapter === undefined) throw new Error(`No understand adapter speaks to upstreams of kind "${kind}"`);
  return adapter;
}
