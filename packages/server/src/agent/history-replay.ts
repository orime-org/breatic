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
import type { ResolvedAgentConfig } from "@breatic/domain";
import { z } from "zod";
import type { MessageData } from "@breatic/shared";

import { toModelMessages } from "@server/agent/model-messages.js";

/** A stored message, with what was sent of it, if anything was kept. */
export type ReplayRow = MessageData & {
  /** `conversation_messages.for_model`, unread. */
  forModel: unknown;
};

/** Everything in a request besides its messages: the agent config it ran with. */
export type RequestPrefix = Pick<ResolvedAgentConfig, "instructions" | "tools" | "modelId">;

const ROLES = new Set(["system", "user", "assistant", "tool"]);

// Read as it was written, never rebuilt: a schema that strips or reorders
// anything would change the bytes this exists to keep.
const sentMessage = z.custom<ModelMessage>((value) => {
  if (value === null || typeof value !== "object") return false;
  const { role, content } = value as { role?: unknown; content?: unknown };
  return typeof role === "string" && ROLES.has(role) && (typeof content === "string" || Array.isArray(content));
});

const userForModel = z.object({
  messages: z.array(sentMessage),
  /**
   * The open Space the message carried: which one, the hash of its section,
   * and whether it went in full or as the line saying it was unchanged.
   */
  snapshot: z.object({ spaceId: z.string(), key: z.string(), full: z.boolean() }).optional(),
});

const replyForModel = z.object({
  messages: z.array(sentMessage),
  prefixHash: z.string(),
  turnTokens: z.number(),
  endTokens: z.number(),
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
  return sha256(JSON.stringify([prefix.modelId, prefix.instructions, tools]));
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
  /** What a reply row kept of what was sent, when it kept anything. */
  reply?: ReplyForModel;
  /** A reply sent again as it was sent, thinking included. */
  asSent: boolean;
}

/**
 * The history as it is replayed, row by row, oldest first.
 * @param rows - Stored messages, oldest first.
 * @param prefix - What the request carries besides its messages.
 * @returns Each row with what it is sent as.
 * @throws {never} Never.
 */
export function replayRows(rows: readonly ReplayRow[], prefix: RequestPrefix): ReplayedRow[] {
  const out: ReplayedRow[] = [];
  let hash = seedHash(prefix);

  for (const row of rows) {
    let replayed: ReplayedRow;
    if (row.role === "user") {
      const kept = userForModel.safeParse(row.forModel);
      replayed = { row, messages: kept.success ? kept.data.messages : toModelMessages([row]), asSent: false };
    } else {
      const kept = replyForModel.safeParse(row.forModel);
      if (!kept.success) replayed = { row, messages: toModelMessages([row]), asSent: false };
      else if (kept.data.prefixHash === hash) {
        replayed = { row, messages: kept.data.messages, reply: kept.data, asSent: true };
      } else {
        replayed = { row, messages: stripThinking(kept.data.messages), reply: kept.data, asSent: false };
      }
    }
    for (const message of replayed.messages) hash = extendHash(hash, message);
    out.push(replayed);
  }
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
    if (row?.role !== "user") continue;
    const kept = userForModel.safeParse(row.forModel);
    const snapshot = kept.success ? kept.data.snapshot : undefined;
    if (snapshot?.full) return snapshot.spaceId === spaceId ? snapshot.key : undefined;
  }
  return undefined;
}
