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
 * before it is unchanged", system and tools included, and once a block is
 * removed it stays out. Each reply row keeps the hash of its turn's prefix;
 * a row whose hash no longer matches, and every row after it, goes back
 * without its thinking.
 *
 * A row written before any of this was kept is rendered from its parts the
 * way it always was.
 */

import { createHash } from "node:crypto";
import { asSchema } from "ai";
import type { ModelMessage, Tool } from "ai";
import { z } from "zod";
import type { MessageData } from "@breatic/shared";

import { toModelMessages } from "@server/agent/model-messages.js";

/** A stored message, with what was sent of it, if anything was kept. */
export type ReplayRow = MessageData & {
  /** `conversation_messages.for_model`, unread. */
  forModel: unknown;
};

/** Everything in a request besides its messages. */
export interface RequestPrefix {
  /** The system prompt, persona through memory. */
  system: string;
  /** The tools as the factory resolved them, keyed by name. */
  tools: Readonly<Record<string, Tool>>;
  /** The model id the request went to, as configured. */
  modelId: string;
}

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
  return sha256(JSON.stringify([prefix.modelId, prefix.system, tools]));
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

/**
 * The history the model is sent, oldest first.
 * @param rows - Stored messages, oldest first.
 * @param prefix - What the request carries besides its messages.
 * @returns The messages to send.
 * @throws {never} Never.
 */
export function historyForModel(rows: readonly ReplayRow[], prefix: RequestPrefix): ModelMessage[] {
  const out: ModelMessage[] = [];
  let hash = seedHash(prefix);
  let thinkingOut = false;

  for (const row of rows) {
    let replayed: ModelMessage[];
    if (row.role === "user") {
      const kept = userForModel.safeParse(row.forModel);
      replayed = kept.success ? kept.data.messages : toModelMessages([row]);
    } else {
      const kept = replyForModel.safeParse(row.forModel);
      if (!kept.success) replayed = toModelMessages([row]);
      else if (!thinkingOut && kept.data.prefixHash === hash) replayed = kept.data.messages;
      else {
        thinkingOut = true;
        replayed = stripThinking(kept.data.messages);
      }
    }
    for (const message of replayed) {
      out.push(message);
      hash = extendHash(hash, message);
    }
  }
  return out;
}

/**
 * What the history last sent in full of a Space.
 * @param rows - Stored messages, oldest first, as they are replayed.
 * @param spaceId - The Space.
 * @returns The hash of that copy, or undefined when none is in the history.
 * @throws {never} Never.
 */
export function lastFullSnapshotKey(rows: readonly ReplayRow[], spaceId: string): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.role !== "user") continue;
    const kept = userForModel.safeParse(row.forModel);
    const snapshot = kept.success ? kept.data.snapshot : undefined;
    if (snapshot?.spaceId === spaceId && snapshot.full) return snapshot.key;
  }
  return undefined;
}
