// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Memory consolidator — folds the oldest part of a conversation into memory
 * entries (#1363).
 *
 * It runs when a turn's request did not fit: the provider's own count left no
 * room, or the provider turned the request away as too long (inner#1567).
 * The caller works out which turns to take, hands them over turn by turn as
 * the messages the model would have been sent, and reassembles once this
 * returns `written` or `superseded`.
 *
 * The consolidation model is fixed in config, whatever model the
 * conversation is answered by. It is shown the turns, the entries it may
 * change in full, the rest by title, and the progress note, and answers with
 * operations on single entries and a new progress note. An answer that fails
 * its checks is asked for again with what was wrong, up to
 * `consolidation_answer_attempts` times. A fold that fails -- the answers
 * never pass, one is cut off, the call or the write fails -- writes nothing
 * and leaves the watermark where it was, so the next fold reads the same
 * turns again; the turn goes on the way the caller decides. Every model call
 * is charged once, under its own key.
 */

import { randomUUID } from "node:crypto";
import { parseCreditDecimal } from "@breatic/shared";

import { stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import {
  generateTextRetry,
  getModel,
  callOptionsFor,
  creditLotService,
  createUsageRecorder,
  handOffLookups,
  resolveProvider,
} from "@breatic/domain";
import type { UsageRecorder } from "@breatic/domain";
import { getAgentConfig, logger, MEMORY_CONTENT_MAX_CHARS, MEMORY_TITLE_MAX_CHARS } from "@breatic/core";
import { memoryService } from "@server/modules";
import type { ConsolidationInput } from "@server/modules/memory/memory.service.js";
import { readConsolidationAnswer } from "@server/agent/consolidation-answer.js";

const CONSOLIDATION_PROMPT = `\
You are the memory consolidator for an AI creative assistant. The turns below are leaving the assistant's context. You are given them, the memory entries the assistant keeps about this user, and where the conversation has got to. Record what the turns add as changes to single entries.

Current entries (shown in full; you may update or delete these):
{entries}

Entries shown by title only (you may not change these; add an entry only for something they do not already cover):
{titles}

Progress so far:
{progress}

Messages to consolidate:
{messages}

Answer with one JSON object and nothing else:
{
  "progress": "Where the conversation has got to and what comes next, at most {progress_max} characters. Facts go into entries, not here.",
  "operations": [
    { "op": "add", "scope": "project or conversation", "title": "...", "content": "..." },
    { "op": "update", "id": "id of an entry shown in full", "title": "...", "content": "..." },
    { "op": "delete", "id": "id of an entry shown in full" }
  ]
}

Rules:
- One fact per entry: a one-line title of at most {title_max} characters saying what it is about, and its content of at most {content_max} characters.
- A "project" entry is read in every conversation of this user's in this Project; a "conversation" entry only in this conversation. Creative direction, characters, style choices, asset details and decisions about the work are "project".
- When an entry on the same thing exists, update it; do not add a second one.
- Delete an entry the user took back, or that the turns show is wrong.
- An entry titled "Earlier project memory" or "Earlier conversation memory" is a block of memory carried over whole: split it into entries with add, then delete it.
- At most {max_operations} operations. An empty list is right when the turns add nothing.
- Write in the language of the conversation.`;

/** One window of a conversation, and where it sits. */
export interface ConsolidationWindow {
  /** Whose conversation it is. */
  userId: string;
  /** The conversation being folded. */
  conversationId: string;
  /** The project it belongs to. */
  projectId: string;
  /**
   * The window turn by turn, oldest first, as the model would have been sent
   * it, less the model's own working.
   */
  turns: ReadonlyArray<{ turnIndex: number; messages: readonly ModelMessage[] }>;
  /** Where the watermark stood before this window was taken. */
  watermarkBefore: number;
  /** The turn the window ends on. */
  newWatermark: number;
  /** Raised when the reader stopped the turn or the client went away. */
  signal?: AbortSignal;
}

/** How one consolidation ended. */
export type ConsolidationOutcome =
  /** Entries, progress note and watermark written together. */
  | "written"
  /** Nothing written, the watermark where it was: the next fold reads the same turns. */
  | "failed"
  /** Another request had already folded from the same watermark; nothing written. */
  | "superseded"
  /** The reader left; nothing written, and the watermark stays for next turn. */
  | "aborted"
  /** The fold never started: what it reads first could not be read. */
  | "untouched";

/**
 * One part of a message, as the prompt reads it: the words, a tool's name and
 * arguments, or what it answered. Anything else is left out -- the model's
 * working, and a provider's private metadata.
 * @param part - A part of a message's content.
 * @returns Its text, or null when it is left out.
 */
function partText(part: unknown): string | null {
  const p = part as { type?: string; text?: string; toolName?: string; input?: unknown; output?: unknown };
  switch (p.type) {
    case "text":
      return p.text ?? "";
    case "tool-call":
      return `[called ${p.toolName ?? ""}] ${JSON.stringify(p.input ?? null)}`;
    case "tool-result": {
      const output = p.output as { value?: unknown } | undefined;
      const value = output?.value;
      return `[${p.toolName ?? ""} answered] ${typeof value === "string" ? value : JSON.stringify(value ?? output ?? null)}`;
    }
    default:
      return null;
  }
}

/**
 * Render the window the way the prompt reads it.
 * @param turns - The window, turn by turn.
 * @returns One block of text, speaker by speaker.
 * @throws {never} Never.
 */
function transcribe(turns: ConsolidationWindow["turns"]): string {
  return turns
    .flatMap((turn) => turn.messages)
    .map((message) => {
      const said =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => partText(part) ?? []).join("\n");
      return `[${message.role}]: ${said}`;
    })
    .join("\n\n");
}

/**
 * The prompt for one fold.
 *
 * One pass over the template, with a function for the replacement. Chained
 * calls rescan what the previous one inserted, so memory holding the literal
 * `{messages}` would take the transcript's place; and a string replacement
 * reads `$&` and its siblings in the inserted text as patterns. A replacer
 * function is handed the text and returns it as it is.
 * @param input - What the fold is shown of memory.
 * @param turns - The window.
 * @returns The prompt.
 * @throws {never} Never.
 */
function promptFor(input: ConsolidationInput, turns: ConsolidationWindow["turns"]): string {
  const config = getAgentConfig();
  const values: Record<string, string> = {
    entries:
      input.full.length === 0
        ? "(none)"
        : input.full.map((e) => `### ${e.id} · ${e.scope} · ${e.title}\n${e.content}`).join("\n\n"),
    titles: input.titlesOnly.length === 0 ? "(none)" : input.titlesOnly.map((e) => `- ${e.id} · ${e.title}`).join("\n"),
    progress: input.progress || "(none yet)",
    messages: transcribe(turns),
    progress_max: String(config.memory_progress_max_chars),
    title_max: String(MEMORY_TITLE_MAX_CHARS),
    content_max: String(MEMORY_CONTENT_MAX_CHARS),
    max_operations: String(config.consolidation_max_operations),
  };
  return CONSOLIDATION_PROMPT.replace(
    /\{(entries|titles|progress|messages|progress_max|title_max|content_max|max_operations)\}/g,
    (_whole, key: string) => values[key] ?? "",
  );
}

/**
 * What the model is told when its answer was refused.
 * @param errors - Every problem found.
 * @returns The message.
 * @throws {never} Never.
 */
function refusal(errors: readonly string[]): string {
  return `Your answer was not accepted:\n${errors.map((e) => `- ${e}`).join("\n")}\nAnswer again with the whole JSON object, corrected.`;
}

/** Who ran one consolidation, over which window, and what it cost. */
interface ConsolidationBill {
  /** Who ran it; recorded as the actor and as the payer of last resort. */
  userId: string;
  /** The conversation it folded. */
  conversationId: string;
  /** Whose studio pays, by way of the project. */
  projectId: string;
  /** Where the watermark stood; part of the idempotency key. */
  watermarkBefore: number;
  /** The recorder the call was recorded on; what it settles to is charged. */
  usage: UsageRecorder;
  /** Which model spent it. */
  model: string;
}

/**
 * The key one model call of a consolidation is recorded and charged under.
 *
 * Each attempt of each fold is its own call and is paid for once. A fold that
 * failed leaves the watermark where it was, so another fold can start from
 * the same one; the id each fold draws tells their calls apart. The same
 * attempt of the same fold presented twice is refused the second charge.
 * @param conversationId - The conversation it folded.
 * @param watermarkBefore - Where the watermark stood.
 * @param foldId - The id this fold drew when it started.
 * @param attempt - Which answer this was, from 1.
 * @returns The key.
 */
function consolidationKey(conversationId: string, watermarkBefore: number, foldId: string, attempt: number): string {
  return `consolidate:${conversationId}:${String(watermarkBefore)}:${foldId}:${String(attempt)}`;
}

/**
 * Charge the studio for one consolidation, and never fail over it.
 *
 * The tokens are spent by the time this is called and the reader is waiting
 * on a reply. Letting a charge take the turn down would fail an answer that
 * has nothing wrong with it, over bookkeeping nobody sees.
 * @param input - Who ran it, over which window, and what it cost.
 */
async function bill(input: ConsolidationBill): Promise<void> {
  const { userId, conversationId, projectId, watermarkBefore, usage, model } = input;

  try {
    const amount = await usage.settle();
    // An OpenRouter call whose cost is not in hand is looked up and charged
    // later, under a key of its own.
    await handOffLookups(usage.awaitingLookup(), usage.operation, {
      model,
      description: "Memory consolidation",
      charge: true,
    }).catch((err: unknown) =>
      logger.error({ err, userId, conversationId, watermarkBefore }, "usage_lookup_enqueue_failed"),
    );
    if (amount === 0) return;
    const outcome = await creditLotService.chargeOnceForGeneration(
      usage.operation.operationKey,
      {
        projectId,
        actorUserId: userId,
        amount,
        description: "Memory consolidation",
        model,
        provider: resolveProvider(model),
      },
    );

    if (outcome && parseCreditDecimal(outcome.shortfall) > 0n) {
      // The pool ran out, or its credits were reassigned while this ran. The
      // call already happened, so what could not be charged goes to
      // reconciliation.
      logger.error(
        {
          userId,
          conversationId,
          studioId: outcome.studioId,
          charged: outcome.charged,
          shortfall: outcome.shortfall,
        },
        // The same key the turn's own charge logs under, so one query finds
        // every model call that ran without being paid for.
        "CREDIT_SHORTFALL_AFTER_COMPLETION — manual reconciliation required",
      );
    }
    if (outcome?.signalFailure) {
      logger.error({ err: outcome.signalFailure, userId, conversationId, projectId }, "credits_signal_failed");
    }
  } catch (err) {
    logger.error({ err, userId, conversationId, watermarkBefore }, "consolidation_charge_failed");
  }
}

/**
 * Fold one window of a conversation into memory entries.
 * @param window - The turns to fold and where they sit.
 * @returns How it ended. The caller reassembles for `written` and
 *   `superseded`, where the watermark moved, and leaves the request alone for
 *   the rest, where the history it measured still stands.
 */
export async function consolidateWindow(window: ConsolidationWindow): Promise<ConsolidationOutcome> {
  const { userId, conversationId, projectId, watermarkBefore, newWatermark, turns, signal } = window;

  // A model call with a bill on it and nobody left to read what it produces.
  if (signal?.aborted) return "aborted";

  /** Which window this is, on every line written about it. */
  const where = { userId, conversationId, projectId, watermarkBefore, newWatermark };

  /**
   * Whether the reader left, said so on the way out.
   *
   * Asked of the signal rather than of the error's name: a name says what the
   * provider called it, and one of the names the SDK treats as cancellation
   * is a timeout, which is the opposite case.
   * @param err - What the failing step threw, when something did.
   * @returns True when the reader had already gone.
   */
  const readerLeft = (err?: unknown): boolean => {
    if (signal?.aborted !== true) return false;
    logger.error({ err, ...where }, "memory_consolidation_aborted");
    return true;
  };

  const config = getAgentConfig();

  // Everything the call is built from, gathered before a single token is
  // spent. A read that fails here costs this turn its fold and nothing else.
  let input: ConsolidationInput;
  let model: ReturnType<typeof getModel>;
  try {
    input = await memoryService.consolidationInput(
      { userId, projectId, conversationId },
      config.consolidation_entries_max_chars,
    );
    model = getModel(config.consolidation_model);
  } catch (err) {
    if (readerLeft(err)) return "aborted";
    logger.error({ err, ...where }, "memory_consolidation_untouched");
    return "untouched";
  }

  const rules = {
    editable: new Set(input.full.map((e) => e.id)),
    maxOperations: config.consolidation_max_operations,
    progressMaxChars: config.memory_progress_max_chars,
  };
  const messages: ModelMessage[] = [{ role: "user", content: promptFor(input, turns) }];
  let errors: string[] = [];
  const foldId = randomUUID();

  // From here on the model is involved, so every ending below has calls
  // behind it that were paid for.
  try {
    for (let attempt = 1; attempt <= config.consolidation_answer_attempts; attempt += 1) {
      // One call, and transport retries happen inside it: `generateTextRetry`
      // is handed `llm_max_retries`.
      const result = await generateTextRetry({
        model,
        messages,
        stopWhen: stepCountIs(1),
        // Folding a transcript has no reasoning step in it, and asks for a
        // fixed temperature of 0. Which of the two each model takes, and how,
        // is settled in the routing table.
        ...callOptionsFor(config.consolidation_model, { thinking: false, cache: false, temperature: 0 }),
        maxOutputTokens: config.max_output_tokens,
        ...(signal ? { abortSignal: signal } : {}),
      });

      // Billed the moment the call comes back, which is the moment the tokens
      // are gone, whatever becomes of the answer.
      const usage = createUsageRecorder({
        operationKey: consolidationKey(conversationId, watermarkBefore, foldId, attempt),
        feature: "memory_consolidation",
        actorUserId: userId,
        projectId,
        onMissingCost: (row) => logger.error({ row, ...where }, "agent_usage_cost_missing"),
      });
      usage.recordModelCall({
        source: "model",
        model: config.consolidation_model,
        provider: resolveProvider(config.consolidation_model),
        usage: result.usage,
        providerMetadata: result.providerMetadata,
        generationId: result.response.id,
      });
      await bill({ userId, conversationId, projectId, watermarkBefore, usage, model: config.consolidation_model });

      if (readerLeft()) return "aborted";
      // An answer cut off by the output limit is cut off again when asked
      // the same way; the fold fails here.
      if (result.finishReason === "length") {
        throw new Error(`consolidation answer was cut off by the output limit at attempt ${String(attempt)}`);
      }

      const read = readConsolidationAnswer(result.text, rules);
      if (read.ok) {
        const outcome = await memoryService.commitConsolidation({
          userId,
          projectId,
          conversationId,
          watermarkBefore,
          newWatermark,
          progress: read.answer.progress,
          operations: read.answer.operations,
        });
        // The call was made and paid for whichever ending it reached, so this
        // line is written for both; the message says which.
        logger.info(
          { ...where, outcome, attempt, operations: read.answer.operations.length },
          outcome === "written" ? "memory_consolidation_written" : "memory_consolidation_superseded",
        );
        return outcome;
      }
      errors = read.errors;
      logger.warn({ ...where, attempt, errors }, "memory_consolidation_answer_refused");
      messages.push({ role: "assistant", content: result.text }, { role: "user", content: refusal(errors) });
    }
    throw new Error(`consolidation answer failed its checks ${String(config.consolidation_answer_attempts)} times: ${errors.join("; ")}`);
  } catch (err) {
    if (readerLeft(err)) return "aborted";
    // The watermark is where it was and nothing was written: the next fold
    // reads these turns again.
    logger.error({ err, ...where }, "memory_consolidation_failed");
    return "failed";
  }
}
