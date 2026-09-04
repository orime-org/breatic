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

/**
 * Code units per code point, at worst.
 *
 * Memory is cut in code points, which is where a character ends, and the
 * assembled payload is measured in code units, which is what a string's
 * length is. Everything above the basic plane is two units per point, and the
 * consolidating prompt asks the model to answer in the language of the
 * conversation.
 */
const MEMORY_RESERVE_FACTOR = 2;

/**
 * How much room a fold may add to the request it is shortening.
 *
 * What the budget measured carries the memory as it stood; what goes out
 * carries what the fold just wrote. A pass has to stop this far short of the
 * keep line to leave room for it.
 * @param ceilings - An object carrying the two memory ceilings, in code points.
 * @param ceilings.memory_conversation_max_size - The conversation ceiling.
 * @param ceilings.memory_project_max_size - The project ceiling.
 * @returns The reserve, in code units.
 */
function reservedForMemory(ceilings: {
  memory_conversation_max_size: number;
  memory_project_max_size: number;
}): number {
  return (
    MEMORY_RESERVE_FACTOR *
    (ceilings.memory_conversation_max_size + ceilings.memory_project_max_size)
  );
}

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
  // A model id has to end in something other than the prefix separator, so
  // that neither a blank value nor a half-typed prefix gets through. Both
  // start clean and fail on the first message: a blank one reaches whatever
  // provider it lands on as an empty id, and `deepseek/` reaches DeepSeek as
  // an empty id too once that key is set, because a direct route strips the
  // prefix it matched.
  default_model: z.string().regex(/[^/]$/).default("deepseek/deepseek-v4-pro"),
  consolidation_model: z.string().regex(/[^/]$/).default("deepseek/deepseek-v4-pro"),
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
  /**
   * How much of a conversation's own memory reaches the system prompt.
   *
   * Consolidation rewrites this layer whole every time it runs, so it is the
   * one segment that grows from its own output.
   */
  memory_conversation_max_size: z.number().int().positive().default(3072),
  /**
   * The ceiling on one model call's answer, in tokens.
   *
   * Per call rather than per turn: `stopWhen: stepCountIs(...)` lets one turn
   * make many, and each of them is bounded by this.
   */
  max_output_tokens: z.number().int().positive().default(16384),
  /**
   * How long one turn's question may be, in characters.
   *
   * Measured on what reaches the model: the message with the canvas content
   * the reader attached folded in front of it. Per field it would admit a
   * short message carrying chips worth many times the limit.
   *
   * The browser draws a lower line and says so as the reader types; this one
   * is where a client cannot skip it.
   */
  user_message_max_chars: z.number().int().positive().default(15000),
  /**
   * How long an assembled request may be before a consolidation runs, in
   * characters.
   *
   * Measured against everything about to go to the model — system prompt,
   * skill bodies, memory, tool definitions, history and this turn's question
   * — because those are what fill a context window, and a budget that only
   * counted the history would be blind to the segments it cannot shorten.
   *
   * Characters rather than tokens: no library counts tokens for a model
   * reached through OpenRouter, and a character is never more than a token in
   * the tokenizers this build meets, so this can only fire early.
   */
  memory_budget_chars: z.number().int().positive().default(850000),
  /**
   * What one consolidation leaves behind, in characters.
   *
   * A pass takes whole turns from the oldest end until what remains is at or
   * under this. Written as "what is left" rather than "how much to take"
   * because a turn has no upper bound — forty model calls, every tool result
   * stored whole — so no fixed amount can promise the reassembled request
   * lands under the budget, and that promise is the point.
   */
  memory_keep_chars: z.number().int().positive().default(500000),
  /**
   * How much page text one `web_search` call asks the service for, in tokens.
   *
   * Both ends of the range belong to the service, not to us: it refuses
   * anything under 1024, and names 32768 as its own ceiling in the error it
   * answers above that. Stating them here is what makes a bad figure fail when
   * the config loads rather than on every search.
   */
  web_search_max_tokens: z.number().int().min(1024).max(32768).default(8192),
  /**
   * How long ONE LEG of a `web_search` may take, in milliseconds.
   *
   * Spent twice per delivery: once by the transport reaching the response, and
   * once by the tool reading its body, which the transport's deadline no longer
   * covers by then. Three deliveries plus the final body read puts the ceiling
   * at four times this figure, plus backoff.
   *
   * The range is the transport's own, not a second opinion: it refuses
   * anything below 1 or above `MAX_TIMER_MS`, because a timer quietly rewrites
   * a figure it cannot hold to one millisecond — turning "wait as long as this
   * needs" into "give up at once". Stating it here is what makes a bad figure
   * fail when the config loads instead of on every call. `.positive()` would
   * not do: it admits 0.5, which the transport then refuses every time.
   */
  web_search_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(10000),
  /** LLM call retry budget (maxRetries), injected by the model-call wrapper. AI SDK default is 2 (#1625 Slice 3). */
  llm_max_retries: z.number().int().min(0).default(2),
}).superRefine((config, ctx) => {
  // A consolidation runs when the request is over the budget and takes turns
  // until what remains is at or under the keep line. Put the keep line at or
  // above the budget and the loop stops before it has taken anything: the
  // plan comes back empty, folding never happens, and every turn from then on
  // goes out at whatever length it happens to be — with nothing said anywhere.
  if (config.memory_keep_chars >= config.memory_budget_chars) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_keep_chars"],
      message: `memory_keep_chars (${config.memory_keep_chars}) must be below memory_budget_chars (${config.memory_budget_chars})`,
    });
  }

  // The pass runs to the keep line less the room the fold may add: it
  // measures a payload carrying the memory as it stood, and the request that
  // goes out carries what the fold wrote. Let the two ceilings reach that
  // line and the pass has nothing to run to — every fold takes the whole
  // conversation, and past it the line is negative, which the loop reads as
  // never stopping. Both are configs that load clean and are found by the
  // first reader whose conversation grows past the budget.
  // The room the fold may add, held back from the keep line below.
  const reserved = reservedForMemory(config);
  if (reserved >= config.memory_keep_chars) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_conversation_max_size"],
      message: `the reserve held back for a fold, twice memory_conversation_max_size + memory_project_max_size (${reserved}), must be below memory_keep_chars (${config.memory_keep_chars})`,
    });
  }
});

/** Validated agent configuration type. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/**
 * The keep line a consolidation pass actually runs to.
 *
 * The configured line less the room the fold may add, worked out here so the
 * arithmetic has one home: the refinement above rejects a pair of ceilings
 * that would put this at or below zero, and it can only do that if it holds
 * back the same amount the pass will.
 * @param config - An object carrying the three figures this is worked out from.
 * @param config.memory_keep_chars - The configured keep line.
 * @param config.memory_conversation_max_size - The conversation ceiling.
 * @param config.memory_project_max_size - The project ceiling.
 * @returns The line, in code units.
 */
export function effectiveKeepChars(config: {
  memory_keep_chars: number;
  memory_conversation_max_size: number;
  memory_project_max_size: number;
}): number {
  return config.memory_keep_chars - reservedForMemory(config);
}

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
