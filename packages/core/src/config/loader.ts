// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * Memory is cut in code points, which is where a character ends. What a fold
 * adds to the request is counted as tokens at a code unit each, which is what
 * a string's length is. Everything above the basic plane is two units per
 * point, and the consolidating prompt asks the model to answer in the
 * language of the conversation.
 */
const MEMORY_RESERVE_FACTOR = 2;

/** How long one memory entry's title may be, in characters (#1363). */
export const MEMORY_TITLE_MAX_CHARS = 120;

/** How long one memory entry's content may be, in characters (#1363). */
export const MEMORY_CONTENT_MAX_CHARS = 4000;

/** What an index line adds besides its title: the full id and a separator. */
const INDEX_LINE_OVERHEAD_CHARS = 36 + 3;

/**
 * How much room a fold may add to the request it is shortening.
 *
 * What a fold measured carries the memory as it stood; what goes out
 * carries what the fold just wrote: at most a full index and a progress note
 * at its ceiling. A migrated block was already in what was measured, and a
 * fold only splits or removes it. A pass has to stop this far short of the
 * keep line to leave room for it.
 * @param ceilings - The memory ceilings.
 * @param ceilings.memory_index_max_entries - How many index lines a prompt carries.
 * @param ceilings.memory_progress_max_chars - The progress note's ceiling.
 * @returns The reserve, in tokens at a code unit each.
 */
export function memoryReserveTokens(ceilings: {
  memory_index_max_entries: number;
  memory_progress_max_chars: number;
}): number {
  const index = ceilings.memory_index_max_entries * (INDEX_LINE_OVERHEAD_CHARS + MEMORY_TITLE_MAX_CHARS);
  return MEMORY_RESERVE_FACTOR * (index + ceilings.memory_progress_max_chars);
}

/** One model the user can pick in the chat panel. */
const chatModelSchema = z.object({
  id: z.string().regex(/[^/]$/),
  name: z.string().trim().min(1),
});

const agentConfigSchema = z.object({
  max_tool_iterations: z.number().int().positive().default(40),
  // A model id has to end in something other than the prefix separator, so
  // that neither a blank value nor a half-typed prefix gets through. Both
  // start clean and fail on the first message: a blank one reaches whatever
  // provider it lands on as an empty id, and `deepseek/` reaches DeepSeek as
  // an empty id too once that key is set, because a direct route strips the
  // prefix it matched.
  default_model: z.string().regex(/[^/]$/).default("deepseek/deepseek-v4.1-flash-1017"),
  /**
   * The models the user can pick in the chat panel, in the order shown
   * (#1363). A conversation with no pick of its own is answered by
   * `default_model`, which must be one of them. Names are English and shown
   * as written.
   */
  chat_models: z
    .array(chatModelSchema)
    .min(1)
    .refine((models) => new Set(models.map((m) => m.id)).size === models.length, "a model is listed twice")
    .default([
      { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
      { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
    ]),
  consolidation_model: z.string().regex(/[^/]$/).default("deepseek/deepseek-v4.1-flash-1017"),
  /**
   * How long a cached prompt prefix lives, for the providers that cache only
   * when asked (Claude). Writes cost 1.25x the input price at 5m and 2x at 1h;
   * reads cost a fraction of it, so the longer lifetime pays off when users
   * come back between five minutes and an hour later.
   */
  prompt_cache_ttl: z.enum(["5m", "1h"]).default("1h"),
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
   * How often an open conversation list asks which conversations have a turn
   * running, in milliseconds, while the last answer named at least one
   * (#1394). Served to the browser through `GET /chat/stream-config`.
   */
  running_poll_interval_ms: z.number().int().positive().default(5000),
  /** How many messages one conversation may hold waiting while a turn runs (inner#1717). */
  chat_queue_max: z.number().int().positive().default(10),
  /** How long a conversation remembers queued message ids for re-send dedupe, in milliseconds (inner#1717). */
  chat_queue_ids_ttl_ms: z.number().int().positive().default(172_800_000),
  /** How long a running turn holds its conversation and running-list lease without renewing, in milliseconds (inner#1717). */
  chat_run_lease_ms: z.number().int().positive().default(60_000),
  /** How often a running turn renews that lease, in milliseconds (inner#1717). */
  chat_run_renew_ms: z.number().int().positive().default(20_000),
  /** How often the shown conversation's page syncs with the server, in milliseconds (inner#1717). */
  chat_sync_interval_ms: z.number().int().positive().default(3000),
  /**
   * How many memory entries the system prompt lists, newest first (#1363).
   * The rest are counted in one line and found through `read_memory`.
   */
  memory_index_max_entries: z.number().int().positive().default(200),
  /** How long a conversation's progress note may be, in characters (#1363). */
  memory_progress_max_chars: z.number().int().positive().default(2000),
  /**
   * How many characters of entries a consolidation is shown in full, newest
   * first after the migrated ones; the rest it sees by id and title only and
   * cannot change (#1363).
   */
  consolidation_entries_max_chars: z.number().int().positive().default(60000),
  /** How many times one consolidation asks for an answer that passes its checks (#1363). */
  consolidation_answer_attempts: z.number().int().positive().default(3),
  /** How many entry operations one consolidation answer may carry (#1363). */
  consolidation_max_operations: z.number().int().positive().default(50),
  /**
   * The ceiling on one model call's answer, in tokens.
   *
   * Per call rather than per turn: `stopWhen: stepCountIs(...)` lets one turn
   * make many, and each of them is bounded by this.
   */
  max_output_tokens: z.number().int().positive().default(16384),
  /**
   * How long the words of one turn's question may be, in characters.
   *
   * The browser draws a lower line and says so as the user types; this one
   * is where a client cannot skip it.
   */
  user_message_max_chars: z.number().int().positive().default(15000),
  /**
   * How many references to attachments one message may carry. Each counts as
   * one character against `user_message_max_chars`, so this is what bounds how
   * much they expand to in what the model is sent.
   */
  user_message_max_references: z.number().int().positive().default(100),
  /**
   * How long the items attached to one message may be, in characters,
   * measured on the attachment section as the model is sent it.
   *
   * Its own limit, apart from the words: an extracted document is far longer
   * than a typed question. The browser checks the same section against this
   * before sending, and reads the number from `GET /chat/stream-config`.
   */
  attachment_max_chars: z.number().int().positive().default(200000),
  /**
   * How many items may be attached to one message: each uploaded file is one,
   * and each pick added from the canvas is one, however many nodes it holds. The browser checks the same number before sending, and
   * reads it from `GET /chat/stream-config`.
   */
  attachment_max_items: z.number().int().positive().default(10),
  product_guide_max_chars_per_call: z.number().int().positive().default(48000),
  /**
   * How long the open Space's content one message carries may be, in
   * characters (inner#1413). The browser cuts the content to this before
   * sending, reading the number from `GET /chat/stream-config`, and tells the
   * model how long it was before the cut.
   */
  current_space_max_chars: z.number().int().positive().default(100000),
  /**
   * How many of the project's Spaces one message may list (inner#1413). The
   * browser lists the newest this many, reading the number from
   * `GET /chat/stream-config`, and tells the model how many it left off.
   */
  space_list_max_items: z.number().int().positive().default(200),
  /**
   * How many Spaces one request to read Spaces may name (inner#1552). The
   * tool refuses a call over it.
   */
  space_request_max_spaces: z.number().int().positive().default(3),
  /** How many canvas nodes one requested Space may be asked for by id (inner#1552). */
  space_request_max_node_ids: z.number().int().positive().default(100),
  /**
   * How long the browser waits for a requested Space it has not opened to
   * sync before it reports the Space as timed out (inner#1552).
   */
  space_read_timeout_ms: z.number().int().positive().default(20000),
  /**
   * What one consolidation leaves behind, in tokens.
   *
   * A fold takes whole turns from the oldest end until what remains is at or
   * under the lower of this and the main model's window less
   * `max_output_tokens`, less the room memory itself takes. A fold runs only
   * when the provider's last count reaches the lower of `fold_trigger_tokens`
   * and the window less `max_output_tokens`, or the provider turned the
   * request away as too long (inner#1567, inner#1879).
   */
  memory_keep_tokens: z.number().int().positive().default(300000),
  /**
   * The known count, in tokens, at which the next call folds first: input
   * plus output the provider reported for the last call. The line in effect
   * is the lower of this and the main model's window less
   * `max_output_tokens` (inner#1879).
   */
  fold_trigger_tokens: z.number().int().positive().default(750000),
  /**
   * The main model's context window when the model directory cannot say, in
   * tokens: the smallest window among the providers that serve the default
   * model.
   */
  context_window_fallback_tokens: z.number().int().positive().default(1000000),
  /**
   * How many folds a provider's "context too long" may set off in one turn.
   * Past it the turn ends as too long rather than paying for another fold.
   */
  overflow_folds_per_turn: z.number().int().min(0).default(2),
  /**
   * How much page text one `web_search` call asks the service for, in tokens.
   *
   * Both ends of the range belong to the service, not to us: it refuses
   * anything under 1024, and names 32768 as its own ceiling in the error it
   * answers above that. Stating them here is what makes a bad figure fail when
   * the config loads rather than on every search.
   *
   * The request carries this figure twice, once for the whole search and once
   * for any single source. The per-source key stops at 8192, so above that the
   * figure reaches the service as the whole-search one and any single page is
   * held to 8192.
   */
  web_search_max_tokens: z.number().int().min(1024).max(32768).default(8192),
  /**
   * How long ONE LEG of a `web_search` may take, in milliseconds.
   *
   * Each delivery gets it, and so does the body read that follows the last one:
   * the transport's deadline is spent by the time it hands the response back, so
   * the read runs under a fresh one. Three deliveries plus that read puts the
   * ceiling at four times this figure, plus backoff.
   *
   * The range is the transport's own, not a second opinion: it refuses
   * anything below 1 or above `MAX_TIMER_MS`, because a timer quietly rewrites
   * a figure it cannot hold to one millisecond — turning "wait as long as this
   * needs" into "give up at once". Stating it here is what makes a bad figure
   * fail when the config loads instead of on every call. `.positive()` would
   * not do: it admits 0.5, which the transport then refuses every time.
   */
  web_search_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(10000),
  /**
   * How long ONE LEG of a `search_images` may take, in milliseconds.
   *
   * Read the same way as the figure above, and the same range for the same
   * reason: both calls reach the same service through the same transport, and
   * a timer cannot hold a figure outside it.
   *
   * How many results one call asks for is not here. That figure is the model's
   * to write, so it lives in the tool's own schema where the SDK holds the
   * model to the range -- a default read from configuration could not, because
   * the schema is built when the module is imported and there is no
   * configuration yet at that point.
   */
  image_search_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(10000),
  /** How many pages one `web_fetch` call may name (inner#1664). */
  web_fetch_max_urls: z.number().int().min(1).max(50).default(20),
  /** How long one `web_fetch` call may take in all, cold start included, in milliseconds. */
  web_fetch_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(90000),
  /** How long one page may take to open, in milliseconds. */
  web_fetch_page_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(30000),
  /** How long a page may keep loading after its document arrives, in milliseconds. */
  web_fetch_settle_ms: z.number().int().min(0).max(MAX_TIMER_MS).default(8000),
  /** How many pages one container opens at once. */
  web_fetch_concurrency: z.number().int().min(1).max(20).default(6),
  /** How many characters of page text one call hands the model, shared by its pages. */
  web_fetch_max_chars: z.number().int().min(1000).max(400000).default(80000),
  /** The largest page or downloaded file one page read may be, in bytes. */
  web_fetch_max_bytes: z.number().int().min(1).default(20971520),
  /** Native picture support override and public model catalog cache timing. */
  main_model_sees_pictures: z.enum(["auto", "yes", "no"]).default("auto"),
  model_catalog_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(1000),
  model_catalog_ttl_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(300000),
  model_catalog_retry_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(30000),
  /** Native JPEG request budgets and the fallback token estimate per occurrence. */
  chat_pictures_max: z.number().int().min(2).max(100).default(50),
  chat_pictures_max_bytes: z.number().int().positive().default(20971520),
  picture_tokens_estimate: z.number().int().positive().default(4784),
  /** Version-one JPEG generation parameters and bounded preparation concurrency. */
  agent_picture_long_edge: z.number().int().positive().default(1024),
  agent_picture_quality: z.number().int().min(1).max(100).default(85),
  agent_picture_concurrency: z.number().int().positive().default(4),
  /** Maximum number of ordered items in one understanding request. */
  understand_media_max_items: z.number().int().positive().default(10),
  /**
   * The largest file `understand_media` will take, in bytes, for all three
   * kinds alike.
   *
   * This figure is what this server will carry, not what the endpoint would
   * accept. A video or audio file is downloaded here, base64'd and held inside
   * a JSON body, so one call at the ceiling occupies several times the ceiling
   * in memory and the upload runs about 60 seconds on a home connection.
   *
   * The endpoint's own ceilings are both higher and both measured, which is why
   * they are the schema's ceiling rather than its default: an image travels as
   * its address and is refused past 31,457,280 bytes ("Downloaded image
   * content cannot exceed 30MB"), and inline media travels base64 inside a
   * body capped at 100,000,000 ("103145588 bytes exceeds the 100000000 byte
   * limit for Google"), which a file of N bytes reaches as ceil(N/3)*4.
   */
  understand_media_max_bytes: z.number().int().min(1).max(31_457_280).default(20_000_000),
  /**
   * How long ONE delivery of the media fetch may take, in milliseconds.
   *
   * It covers reaching the response headers. What follows — reading a body
   * that may be tens of megabytes — runs under a budget worked out from the
   * file's own size and the rate below.
   *
   * The range is the transport's, for the reason the search key states: a
   * timer rewrites a figure it cannot hold to one millisecond.
   */
  understand_media_fetch_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(30_000),
  /**
   * The rate a media body is expected to arrive at, in bytes per second.
   *
   * The read budget is the file's size divided by this: below it, whoever
   * is sending is not going to finish.
   */
  understand_media_min_bytes_per_sec: z.number().int().min(1).default(65_536),
  /**
   * The smallest read budget for a media body, in milliseconds.
   *
   * The budget is the file's size over the rate above, and a small file
   * divides down to almost nothing — a 40 KB audio clip would be called slow
   * for taking half a second. This is the floor that division cannot go under.
   * Only video and audio reach it: an image travels as its address and its
   * bytes never come here.
   */
  understand_media_read_floor_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(5_000),
  /**
   * How long ONE delivery of the model call may take, in milliseconds.
   *
   * The whole clip goes up inside it. Measured: 26 MiB of base64 took 61
   * seconds — 446,934 bytes a second, which puts a 20 MB file (26,666,668
   * bytes once base64'd) at about 60. This leaves room for a slower link.
   */
  understand_media_call_timeout_ms: z.number().min(1).max(MAX_TIMER_MS).default(180_000),
  /**
   * How long the WHOLE judgement call may take, in milliseconds.
   *
   * Every delivery and every backoff between them, not one delivery: a
   * signal spanning the call is what holds the wait to this. Declining
   * replay settles only the deliveries the caller owns, and a 429 or a 408
   * is replayed whatever the caller declared. Measured 2026-09-23: 285-395 ms once connected,
   * 1181 ms on the first call of a process.
   */
  judge_likelihood_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(10_000),
  /**
   * How much the model may write about one ordered media batch, in tokens.
   * All items share this output allowance.
   *
   * The same bounds and the same default as `web_search_max_tokens`: both cap
   * one answer from one model, and a floor matters here because a description
   * cut off at the length limit reaches the user as a half sentence.
   */
  understand_media_max_output_tokens: z.number().int().min(1024).max(32768).default(8192),
  /**
   * How long after an OpenRouter call whose cost was not in hand (cut off, or
   * ended without one) its cost is first looked up, in milliseconds (#296). OpenRouter keeps generating for providers
   * that cannot be cancelled, so the cost is settled only once it is done.
   */
  usage_lookup_delay_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(30_000),
  /**
   * How many times that lookup is made before the call is recorded as
   * missing. Retries back off exponentially from the delay above.
   */
  usage_lookup_attempts: z.number().int().min(1).max(20).default(6),
  /** LLM call retry budget (maxRetries), injected by the model-call wrapper. AI SDK default is 2 (#1625 Slice 3). */
  llm_max_retries: z.number().int().min(0).default(2),
  /** How many rows one page of a record tool holds: conversations, hits, tasks, versions (inner#1469). */
  records_page_size: z.number().int().min(1).max(100).default(20),
  /** How many words of a conversation search are matched; the rest are left out. */
  records_search_max_terms: z.number().int().min(1).max(20).default(5),
  /** How many characters a search hit shows on each side of the first match. */
  records_snippet_chars: z.number().int().min(1).default(80),
  /** How long a node version's prompt and its content (text, or a value that is one link and nothing else) may be in characters before it is cut. */
  records_version_text_max_chars: z.number().int().min(100).default(4000),
  /** How long one page of a read conversation may be, in characters; a page still holds at least one whole turn. Each text part is cut to this length, and a search matches a text part only that far. */
  records_page_max_chars: z.number().int().min(1000).default(24000),
  /** How long a version's parameters, written as one line of JSON, may be in characters. */
  records_params_max_chars: z.number().int().min(10).default(400),
  /** How long the words of one tool call's input, or of its result, may be in characters when a message is read back; a search matches a tool's input cut to the same length, never its result. A questionnaire (an ask_user call that did not fail) is written and matched whole, its answers included. */
  records_tool_text_max_chars: z.number().int().min(10).default(600),
}).superRefine((config, ctx) => {
  // A conversation nobody picked a model for is answered by the default, and
  // the picker shows the model that answers it: one it does not list would
  // be a name the user can neither see nor pick back.
  if (!config.chat_models.some((m) => m.id === config.default_model)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default_model"],
      message: `default_model (${config.default_model}) must be one of chat_models`,
    });
  }

  // The pass runs to the keep line less the room the fold may add: it
  // measures a payload carrying the memory as it stood, and the request that
  // goes out carries what the fold wrote. Let the two ceilings reach that
  // line and the pass has nothing to run to — every fold takes the whole
  // conversation, and past it the line is negative, which the loop reads as
  // never stopping. Both are configs that load clean and are found by the
  // first user whose conversation needs a fold.
  // The room the fold may add, held back from the keep line below.
  const reserved = memoryReserveTokens(config);
  if (reserved >= config.memory_keep_tokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_index_max_entries"],
      message: `the reserve held back for a fold for the memory index and the progress note (${reserved}) must be below memory_keep_tokens (${config.memory_keep_tokens})`,
    });
  }

  // A fold leaves up to the keep line, and the next call reports at least
  // that much. A keep line at or above the trigger is back on the trigger at
  // once, so every call would pay for another fold.
  if (config.memory_keep_tokens >= config.fold_trigger_tokens) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fold_trigger_tokens"],
      message: `memory_keep_tokens (${config.memory_keep_tokens}) must be below fold_trigger_tokens (${config.fold_trigger_tokens}): a fold leaves up to the keep line, so a keep line at or above the trigger folds again on the very next call`,
    });
  }

  // The media read budget is `size / rate`, handed to a timer as a deadline.
  // A figure past what a timer holds is rewritten to 1ms rather than refused,
  // so every video and every audio clip would fail the instant the read began
  // and be reported as a download that ran out of time. Neither knob is
  // anything the user chose, so the refusal belongs at load, in front of the
  // operator who typed the number. Checked as a pair because the budget is a
  // product of the two and bounding one alone leaves the other way in open.
  const worstReadMs = Math.ceil(
    (config.understand_media_max_bytes / config.understand_media_min_bytes_per_sec) * 1000,
  );
  if (worstReadMs > MAX_TIMER_MS) {
    const lowestUsable = Math.ceil((config.understand_media_max_bytes * 1000) / MAX_TIMER_MS);
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["understand_media_min_bytes_per_sec"],
      message: `understand_media_min_bytes_per_sec ${config.understand_media_min_bytes_per_sec} sizes the read budget at ${worstReadMs}ms for a file at the ${config.understand_media_max_bytes}-byte cap, past the ${MAX_TIMER_MS}ms a timer can hold; every video and audio clip would be called slow before a byte arrived. Raise it to at least ${lowestUsable}, or lower understand_media_max_bytes.`,
    });
  }
});

/** Validated agent configuration type. */
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** How long a cached prompt prefix lives. */
export type PromptCacheTtl = AgentConfig["prompt_cache_ttl"];

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
