// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { CONVERSATION_TITLE_MAX_CHARS, MAX_TIMER_MS } from "@breatic/shared";
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
  default_model: z.string().default("deepseek/deepseek-v4-pro"),
  consolidation_model: z.string().default("deepseek/deepseek-v4-pro"),
  memory_window: z.number().int().positive().default(20),
  /**
   * How much of the first message a conversation keeps as its name.
   *
   * A conversation is named after the first thing said in it, and people open
   * one by typing a whole paragraph as often as a line. Cut so the list stays
   * readable; the full message is a scroll away in the conversation itself.
   */
  // Capped at what the column stores, and both sides count the same thing:
  // characters. They did not always -- the cut on the way in counted UTF-16
  // code units, so a name of emoji within the limit was cut anyway, between
  // the halves of one of them, and the replacement mark that produced stayed
  // in that name for good.
  conversation_title_max_chars: z
    .number()
    .int()
    .positive()
    .max(CONVERSATION_TITLE_MAX_CHARS)
    .default(60),
  conversation_page_size: z.number().int().positive().default(30),
  /**
   * How many messages one page of a conversation holds.
   *
   * The same figure as the list above it, on purpose: the two are the same
   * kind of dial and whoever reads this file should not have to hold two
   * numbers. It replaces a literal in the message repo whose value had no
   * reason recorded anywhere near it.
   *
   * A page is cut on a turn boundary, so what arrives is at most this and
   * lands on whole turns.
   */
  message_page_size: z.number().int().positive().default(30),
  /**
   * How often the chat stream says it is still alive, in milliseconds.
   *
   * The client treats three missed beats as a stream that has gone, and that
   * count stays in code: the server garbage collects, two misses in a row
   * happen to a healthy stream, and a deployment that tuned the count down
   * would start killing turns that were doing fine.
   */
  sse_heartbeat_interval_ms: z.number().int().positive().default(5000),
  memory_keep_recent_turns: z.number().int().positive().default(3),
  /**
   * How many of the most recent tool uses keep their result in the context.
   *
   * Counted in tool use/result pairs rather than turns: one turn can run
   * forty model calls whose whole output lands in a single stored row, so a
   * turn-shaped window is three orders of magnitude coarser than the thing
   * filling the context. The default matches the one figure the industry
   * agrees on — Anthropic's `clear_tool_uses_20250919` keeps three.
   */
  tool_result_keep: z.number().int().positive().default(3),
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
   * Off, because asking for it changes nothing that comes back. Measured on
   * the model this build calls: 2026-08-20, deepseek/deepseek-v4-pro through
   * OpenRouter, two turns with this on — one of them asking in so many words
   * for the working to be written out. Both opened a reasoning channel and
   * closed it about 300ms later with zero `reasoning-delta` between. The
   * earlier measurement said the same of a different model (2026-08-11,
   * claude-sonnet-4-6, three turns, nothing).
   *
   * The pipeline that carries reasoning is built and tested; what is missing
   * is that nothing is actually asked for. `@ai-sdk/openai@4.0.37` decides
   * whether a model reasons from its id (the o-series, gpt-5 and up), and
   * `deepseek/deepseek-v4-pro` matches neither — so `reasoningEffort` is
   * dropped with an `unsupported` warning rather than sent
   * (`dist/index.js:6306-6311`).
   */
  thinking_enabled: z.boolean().default(false),
  /** LLM call retry budget (maxRetries), injected by the model-call wrapper. AI SDK default is 2 (#1625 Slice 3). */
  llm_max_retries: z.number().int().min(0).default(2),
});

/** Validated agent configuration type. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * The agent config shape, for tests that assert on its bounds.
 *
 * Exported rather than rebuilt in the test: a copy would pass while the real
 * one drifts, which is the whole failure this bound exists to prevent.
 */
export const agentConfigSchemaForTests = agentConfigSchema;

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
