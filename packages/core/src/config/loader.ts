// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * YAML configuration loader.
 *
 * Reads and parses YAML config files for agent behavior parameters
 * and model catalogs. Returns frozen readonly objects.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_TIMER_MS } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const agentConfigSchema = z.object({
  max_tool_iterations: z.number().int().positive().default(40),
  /**
   * Step ceiling for a worker task running one skill.
   *
   * Separate from `max_tool_iterations` on purpose: chat has a person
   * waiting and can afford more turns, a worker task is a bounded job.
   * Both used to be literals in three places, disagreeing 40 against 15.
   */
  skill_agent_max_steps: z.number().int().positive().default(15),
  default_model: z.string().default("anthropic/claude-sonnet-4-6"),
  consolidation_model: z.string().default("anthropic/claude-sonnet-4-6"),
  memory_window: z.number().int().positive().default(20),
  /**
   * How much of the first message a conversation keeps as its name.
   *
   * A conversation is named after the first thing said in it, and people open
   * one by typing a whole paragraph as often as a line. Cut so the list stays
   * readable; the full message is a scroll away in the conversation itself.
   */
  conversation_title_max_chars: z.number().int().positive().default(60),
  conversation_page_size: z.number().int().positive().default(30),
  memory_keep_recent_turns: z.number().int().positive().default(3),
  full_detail_turns: z.number().int().positive().default(3),
  memory_project_max_size: z.number().int().positive().default(3072),
  memory_user_max_size: z.number().int().positive().default(2048),
  web_fetch_max_chars: z.number().int().positive().default(50000),
  /**
   * How long ONE DELIVERY of a `web_fetch` request may take, in milliseconds.
   *
   * The range is the transport's own, not a second opinion: it refuses
   * anything below 1 or above `MAX_TIMER_MS`, because a timer quietly rewrites
   * a figure it cannot hold to one millisecond — turning "wait as long as this
   * needs" into "give up at once". Stating it here is what makes a bad figure
   * fail when the config loads instead of on every call. `.positive()` would
   * not do: it admits 0.5, which the transport then refuses every time.
   */
  web_fetch_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(30000),
  /** The same, for one `web_search` request. */
  web_search_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(10000),
  /**
   * Whether to ask the provider for the model's working while it answers.
   *
   * Defaults off: asking currently gets nothing back. Measured 2026-08-11
   * against claude-sonnet-4-6 with the summary asked for by name — three
   * turns, no reasoning, one of them a question that spelled out "show your
   * reasoning step by step". The pipeline that carries it is built and
   * tested; what is missing is on the provider side.
   */
  thinking_enabled: z.boolean().default(false),
  /** LLM call retry budget (maxRetries), injected by the model-call wrapper. AI SDK default is 2 (#1625 Slice 3). */
  llm_max_retries: z.number().int().min(0).default(2),
});

/** Validated agent configuration type. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

let _cachedConfig: Readonly<AgentConfig> | null = null;

/**
 * Load and validate agent configuration from YAML.
 * @param configDir - Path to the config directory (defaults to `../../config`)
 * @returns Frozen, validated agent configuration
 */
export function getAgentConfig(configDir?: string): Readonly<AgentConfig> {
  if (_cachedConfig) return _cachedConfig;

  const dir = configDir ?? resolve(MONOREPO_ROOT, "config");
  const filePath = resolve(dir, "agent.yaml");
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = agentConfigSchema.parse(parsed);

  _cachedConfig = Object.freeze(config);
  return _cachedConfig;
}

/** Reset cached config (for testing). */
export function resetAgentConfig(): void {
  _cachedConfig = null;
}
