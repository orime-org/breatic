// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The history, replayed as it was sent (inner#1549).
 *
 * A provider caches the prefix of a request and reads it back on the next one
 * only when it is the same, byte for byte. Each message is therefore stored as
 * it was sent (`conversation_messages.for_model`) and sent again as it is, so
 * the next turn's request is the last one with something added at the end.
 *
 * A reply's thinking can go back only while everything sent before it is what
 * its turn sent: Anthropic's preserved thinking holds "everything you sent
 * before it is unchanged", system and tools included. Each reply row keeps
 * the hash of its turn's prefix, and a row whose hash no longer matches goes
 * back without its thinking. Taking a block out changes every byte after it,
 * so the replies made while it was there stop matching too, and the ones made
 * after it was gone still match. Putting it back -- the tools or the system
 * prompt change and change back, as the tools do when the reader switches the
 * interface language and switches it back -- does the same to the replies
 * made while it was gone, so the blocks kept need not be one run: after A, B,
 * A, A, the first and third keep theirs and the second does not (Anthropic
 * answered all four, with the interface language switched).
 *
 * A row written before any of this was kept is rendered from its parts the
 * way it always was.
 */

import { createHash } from "node:crypto";
import { asSchema } from "ai";
import type { ModelMessage } from "ai";
import { ASK_USER, expandAgentPictures, instructionsText, projectAgentRequest } from "@breatic/domain";
import type { AgentPicture, AgentPicturePolicy, ResolvedAgentConfig } from "@breatic/domain";
import { z } from "zod";
import type { MessageData } from "@breatic/shared";

import { UNANSWERED_ASK } from "@server/agent/ask-result.js";
import { toModelMessages } from "@server/agent/model-messages.js";

/** A stored message, with what was sent of it, if anything was kept. */
export type ReplayRow = MessageData & {
  /** `conversation_messages.for_model`, unread. */
  forModel: unknown;
};

/** Everything in a request besides its messages: the agent config it ran with. */
export type RequestPrefix = Pick<ResolvedAgentConfig, "instructions" | "tools" | "modelId"> & {
  picturePolicy?: AgentPicturePolicy;
};

const ROLES = new Set(["system", "user", "assistant", "tool"]);

// Read as it was written, never rebuilt: a schema that strips or reorders
// anything would change the bytes this exists to keep.
const sentMessage = z.custom<ModelMessage>((value) => {
  if (value === null || typeof value !== "object") return false;
  const { role, content } = value as { role?: unknown; content?: unknown };
  return typeof role === "string" && ROLES.has(role) && (typeof content === "string" || Array.isArray(content));
});

/**
 * The open Space a message carried: which one, the hash of its section, and
 * whether it went in full or as the line saying it was unchanged.
 */
const snapshot = z.object({ spaceId: z.string(), key: z.string(), full: z.boolean() });
const picture = z.object({ label: z.string(), sourceUrl: z.string(), url: z.string(), sizeBytes: z.number().nonnegative(), mediaType: z.literal("image/jpeg") });
const generationStep = z.object({ messageStart: z.number().int().nonnegative(), messageEnd: z.number().int().nonnegative(), prefixHash: z.string() });

const userForModel = z.object({
  messages: z.array(sentMessage),
  snapshot: snapshot.optional(),
  pictures: z.array(picture).optional(),
});

const replyForModel = z.object({
  messages: z.array(sentMessage),
  prefixHash: z.string(),
  turnTokens: z.number(),
  endTokens: z.number(),
  /** The open Space a resumed segment's own message carried (inner#1542). */
  snapshot: snapshot.optional(),
  pictures: z.array(picture).optional(),
  steps: z.array(generationStep).optional(),
  countCoverage: z.object({ version: z.literal(1), turnHash: z.string().optional(), endHash: z.string().optional() }).optional(),
});

/** What a user row keeps of what was sent. */
export type UserForModel = z.infer<typeof userForModel>;

/** What a reply row keeps of what was sent. */
export type ReplyForModel = z.infer<typeof replyForModel>;

// Parts that carry a model's working or only a provider's private payload.
// `custom` holds nothing but `providerOptions`, which goes too.
const THINKING_PARTS = new Set(["reasoning", "reasoning-file", "custom"]);

/**
 * The same messages without the model's thinking.
 *
 * Takes out every reasoning part and every `providerOptions`, on parts and on
 * messages alike: through OpenRouter, the signed `reasoning_details` ride on a
 * step's first tool call, so removing the reasoning parts alone leaves them.
 * An assistant message left with nothing is dropped.
 * @param messages - Messages as they were sent.
 * @returns The messages without thinking.
 * @throws {never} Never.
 */
export function stripThinking(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    const { providerOptions: _dropped, ...rest } = message;
    if (typeof rest.content === "string") return [rest];
    const content = (rest.content as ReadonlyArray<{ type: string; providerOptions?: unknown }>)
      .filter((part) => !THINKING_PARTS.has(part.type))
      .map(({ providerOptions: _gone, ...part }) => part);
    if (content.length === 0 && rest.role === "assistant") return [];
    return [{ ...rest, content } as ModelMessage];
  });
}

/**
 * Hash some text.
 * @param text - The text.
 * @returns Its SHA-256, hex.
 * @throws {never} Never.
 */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The hash of a request with no messages yet.
 * @param prefix - The system prompt, tools and model.
 * @returns The hash.
 * @throws {never} Never.
 */
function seedHash(prefix: RequestPrefix): string {
  // The tool definitions as the SDK converts them for the provider.
  const tools = Object.entries(prefix.tools).map(([name, definition]) => [
    name,
    definition.description ?? null,
    asSchema(definition.inputSchema).jsonSchema,
  ]);
  return sha256(JSON.stringify([
    prefix.modelId, instructionsText(prefix.instructions), tools,
    ...(prefix.picturePolicy === undefined ? [] : [{ projectionVersion: 1, ...prefix.picturePolicy }]),
  ]));
}

/**
 * The hash once one more message is added.
 * @param hash - The hash so far.
 * @param message - The message.
 * @returns The new hash.
 * @throws {never} Never.
 */
function extendHash(hash: string, message: ModelMessage): string {
  return sha256(`${hash}\n${JSON.stringify(message)}`);
}

/**
 * The hash of a request's prefix: its system prompt, tools and model, and the
 * messages in front.
 *
 * Built one message at a time, so replay reaches the same value by adding
 * each message as it lays it down.
 * @param prefix - The system prompt, tools and model.
 * @param messages - The messages, oldest first.
 * @returns The hash.
 * @throws {never} Never.
 */
export function prefixHash(prefix: RequestPrefix, messages: readonly ModelMessage[]): string {
  return messages.reduce(extendHash, seedHash(prefix));
}

/** One stored message, as it is replayed. */
export interface ReplayedRow {
  /** The stored message. */
  row: ReplayRow;
  /** What it is sent as. */
  messages: ModelMessage[];
  /** Selected logical messages before the deterministic tool-picture expansion. */
  logicalMessages?: ModelMessage[];
  /** What a reply row kept of what was sent, when it kept anything. */
  reply?: ReplyForModel;
  /** A reply sent again as it was sent, thinking included. */
  asSent: boolean;
  /** Hash of the projected segment whose provider increment may be reused. */
  turnCoverageHash?: string;
  /** Hash of the entire projected conversation through this row. */
  endCoverageHash?: string;
}

/**
 * Read only validated durable JPEG facts, without importing legacy URLs.
 * @param rows - Stored conversation rows.
 * @returns Their prepared picture facts in row order.
 * @throws {never} Never.
 */
export function pictureFactsOfRows(rows: readonly ReplayRow[]): AgentPicture[] {
  return rows.flatMap((row) => {
    const kept = (row.role === "user" ? userForModel : replyForModel).safeParse(row.forModel);
    return kept.success ? kept.data.pictures ?? [] : [];
  });
}

/**
 * The history as it is replayed, row by row, oldest first.
 * @param rows - Stored messages, oldest first.
 * @param prefix - What the request carries besides its messages.
 * @param following - Current messages whose pictures participate in the same history budget.
 * @param following.messages - The current turn's logical user messages.
 * @param following.pictures - Their durable prepared JPEG facts.
 * @returns Each row with what it is sent as.
 * @throws {never} Never.
 */
export function replayRows(
  rows: readonly ReplayRow[],
  prefix: RequestPrefix,
  following: { messages: readonly ModelMessage[]; pictures: readonly AgentPicture[] } = { messages: [], pictures: [] },
): ReplayedRow[] {
  const out: ReplayedRow[] = [];
  let hash = seedHash(prefix);
  const facts: AgentPicture[] = [];
  const raw = rows.map((row) => {
    const kept = (row.role === "user" ? userForModel : replyForModel).safeParse(row.forModel);
    if (kept.success) facts.push(...(kept.data.pictures ?? []));
    return kept.success ? kept.data.messages : toModelMessages([row]);
  });
  facts.push(...following.pictures);
  const original = [...raw.flat(), ...following.messages];
  const projection = prefix.picturePolicy === undefined ? undefined : projectAgentRequest({
    messages: original, pictures: facts, policy: prefix.picturePolicy, phase: "initial",
  });
  let offset = 0;
  const sentPrefix: ModelMessage[] = [];
  const turnsWithReply = new Set<number>();
  const turnUsers = new Map<number, ModelMessage[]>();

  for (const [rowIndex, row] of rows.entries()) {
    const rowOriginal = raw[rowIndex] ?? [];
    const logical = projection?.logicalMessages.slice(offset, offset + rowOriginal.length) ?? structuredClone(rowOriginal);
    const ownChanged = projection?.changedMessageIndices.some((index) => index >= offset && index < offset + rowOriginal.length) ?? false;
    offset += rowOriginal.length;
    let replayed: ReplayedRow;
    if (row.role === "user") {
      replayed = { row, messages: logical, asSent: false };
    } else {
      const kept = replyForModel.safeParse(row.forModel);
      if (!kept.success) replayed = { row, messages: stripThinking(logical), asSent: false };
      else if (kept.data.steps?.length) {
        const messages: ModelMessage[] = [];
        let cursor = 0;
        for (const step of kept.data.steps) {
          if (step.messageStart < cursor || step.messageEnd <= step.messageStart || step.messageEnd > logical.length) continue;
          messages.push(...stripThinking(logical.slice(cursor, step.messageStart)));
          const before = [...sentPrefix, ...(prefix.picturePolicy === undefined ? messages : expandAgentPictures(messages))];
          const body = logical.slice(step.messageStart, step.messageEnd);
          const changed = JSON.stringify(body) !== JSON.stringify(rowOriginal.slice(step.messageStart, step.messageEnd));
          messages.push(...(step.prefixHash === prefixHash(prefix, before) && !changed ? body : stripThinking(body)));
          cursor = step.messageEnd;
        }
        messages.push(...stripThinking(logical.slice(cursor)));
        replayed = { row, messages, reply: kept.data, asSent: !ownChanged && JSON.stringify(messages) === JSON.stringify(rowOriginal) };
      } else if (kept.data.prefixHash === hash && !ownChanged) {
        replayed = { row, messages: logical, reply: kept.data, asSent: true };
      } else {
        replayed = { row, messages: stripThinking(logical), reply: kept.data, asSent: false };
      }
    }
    replayed = { ...replayed, messages: withEveryCallAnswered(replayed.messages) };
    replayed.logicalMessages = replayed.messages;
    if (prefix.picturePolicy !== undefined) replayed.messages = expandAgentPictures(replayed.messages);
    if (row.role === "user") turnUsers.set(row.turnIndex, replayed.messages);
    else {
      const segment = [...(turnsWithReply.has(row.turnIndex) ? [] : turnUsers.get(row.turnIndex) ?? []), ...replayed.messages];
      replayed.turnCoverageHash = prefixHash(prefix, segment);
      turnsWithReply.add(row.turnIndex);
    }
    for (const message of replayed.messages) hash = extendHash(hash, message);
    sentPrefix.push(...replayed.messages);
    replayed.endCoverageHash = hash;
    out.push(replayed);
  }
  return out;
}

/** What the model reads for a call of any other tool that has no result. */
const NO_RESULT = "This call has no result: the turn ended before it did.";

/**
 * A row's messages with a result for every tool call in them.
 *
 * A call can be left without one in ordinary use: a questionnaire the user
 * never answered, a turn stopped after the model asked for a tool and before
 * it ran. Providers refuse a request holding a call with no result after it,
 * so each such call gets one here, as the request is put together, right
 * after the run of tool messages that follows its call -- the way LangGraph's
 * dangling-call repair and the AI SDK's synthetic denial results do it.
 * Nothing stored changes, and the same row gives the same bytes every time.
 * @param messages - One row's messages, as they are replayed.
 * @returns The same messages, every call answered.
 */
function withEveryCallAnswered(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let open: Array<{ toolCallId: string; toolName: string }> = [];
  /** Answer the calls still open, in one tool message after the last one. */
  const close = (): void => {
    if (open.length === 0) return;
    out.push({
      role: "tool",
      content: open.map(({ toolCallId, toolName }) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: { type: "error-text" as const, value: toolName === ASK_USER ? UNANSWERED_ASK : NO_RESULT },
      })),
    });
    open = [];
  };
  for (const message of messages) {
    if (message.role === "tool") {
      const answered = new Set(
        Array.isArray(message.content)
          ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
          : [],
      );
      open = open.filter((call) => !answered.has(call.toolCallId));
      out.push(message);
      continue;
    }
    close();
    out.push(message);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.providerExecuted !== true) {
          open.push({ toolCallId: part.toolCallId, toolName: part.toolName });
        }
      }
    }
  }
  close();
  return out;
}

/**
 * What the history last sent in full of a Space, when the newest Space sent
 * in full is that one.
 *
 * The line that stands in for an unchanged Space points at "the most recent
 * message above that shows its content", and two Spaces can share a name, so
 * a Space sent in full after it takes that place.
 * @param rows - Stored messages, oldest first, as they are replayed.
 * @param spaceId - The Space.
 * @returns The hash of that copy, or undefined when the newest copy sent in
 *   full is another Space's or there is none.
 * @throws {never} Never.
 */
export function lastFullSnapshotKey(rows: readonly ReplayRow[], spaceId: string): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined) continue;
    // A reader's message carries the Space, and so does the message a segment
    // resumed after a questionnaire opens with.
    const kept = (row.role === "user" ? userForModel : replyForModel).safeParse(row.forModel);
    const sent = kept.success ? kept.data.snapshot : undefined;
    if (sent?.full) return sent.spaceId === spaceId ? sent.key : undefined;
  }
  return undefined;
}
