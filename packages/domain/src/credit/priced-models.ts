// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The models the agent runs on, which the services check at startup have a way to be priced (#296): provider's
 * `assertModelsPriced` refuses one reached directly without a price, where whoever edited the config is watching.
 */

import { getAgentConfig } from "@breatic/core";

/**
 * The models the agent's own paths run on: every model the user can pick
 * for chat, and memory consolidation.
 * @returns Each model id once.
 */
export function agentModelIds(): string[] {
  const config = getAgentConfig();
  return [...new Set([...config.chat_models.map((m) => m.id), config.consolidation_model])];
}
