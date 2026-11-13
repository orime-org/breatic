// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The upstream kinds that take an Anthropic Messages request, for the web-animation relay. */

import { anthropicMessages } from "@provider/llm/upstreams/anthropic.messages.js";
import type { MessagesSpeaker } from "@provider/llm/upstreams/common.js";
import { deepSeekMessages } from "@provider/llm/upstreams/deepseek.messages.js";
import { openRouterMessages } from "@provider/llm/upstreams/openrouter.messages.js";

const SPEAKERS: Readonly<Record<string, MessagesSpeaker>> = { openrouter: openRouterMessages, anthropic: anthropicMessages, deepseek: deepSeekMessages };

/**
 * How an upstream kind takes a Messages request, when it does.
 * @param kind - The upstream kind.
 * @returns Its speaker, or undefined.
 */
export function messagesSpeakerOf(kind: string): MessagesSpeaker | undefined {
  return Object.hasOwn(SPEAKERS, kind) ? SPEAKERS[kind] : undefined;
}
