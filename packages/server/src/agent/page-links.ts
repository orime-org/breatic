// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The links one turn's `web_fetch` may read: every link the conversation
 * holds, from the places listed here and nowhere else (inner#1664).
 *
 * The rule is Anthropic's for its own web fetch: a page is read only when its
 * link appeared in the user's messages or in what an earlier search or read
 * returned, so text in a page cannot have the model send the user's data out
 * inside an address it made up. What the model wrote -- its prose, its tool
 * inputs, a questionnaire's option labels -- adds nothing.
 *
 * Every place a link is taken from is a structured field, with one exception:
 * a user row's `forModel` text. That text is built only from the user's side
 * (the clock, the Space list, the open Space's body, attachments, the typed
 * words and the language note), so reading all of it is reading the user.
 */
import type { ModelMessage } from "ai";
import { pageLinkKey, pageLinksIn } from "@breatic/shared";

import { conversationService } from "@server/modules";
import type { ReplayRow } from "@server/agent/history-replay.js";

/** The turn's set of links. */
export interface PageLinks {
  /** Note the links one stored row holds. */
  addRow(row: ReplayRow): void;
  /** Note the links the message sent to the model this turn holds. */
  addUserMessage(message: ModelMessage): void;
  /** Note the links one tool result of this turn holds. */
  addToolResult(toolName: string, output: unknown): void;
  /** Whether a link is in the set. */
  allows(url: string): boolean;
  /**
   * The spelling the set first recorded for a link's key, a bare host given
   * `https://`; undefined when the set does not hold it.
   */
  urlFor(url: string): string | undefined;
}

/**
 * An object's field, or nothing when the value is not an object.
 * @param value - The value.
 * @param key - The field.
 * @returns The field's value.
 */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * The entries of a list, or none when the value is not a list.
 * @param value - The value.
 * @returns Its entries.
 */
function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The strings among a list's entries.
 * @param value - The value.
 * @returns Its string entries.
 */
function strings(value: unknown): string[] {
  return entries(value).filter((entry): entry is string => typeof entry === "string");
}

/**
 * The texts a message's content carries.
 * @param content - A model message's content.
 * @returns Its text, or the text of each of its text parts.
 */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return entries(content).flatMap((part) => {
    const text = field(part, "text");
    return field(part, "type") === "text" && typeof text === "string" ? [text] : [];
  });
}

/**
 * The links in the structured fields of one tool's result.
 *
 * `ask_user` gives only what the user wrote on a question's Other line: the
 * options it picked are labels the model wrote.
 * @param toolName - The tool.
 * @param output - What it returned.
 * @returns The links.
 */
function linksOfResult(toolName: string, output: unknown): string[] {
  switch (toolName) {
    case "web_search":
      return entries(field(output, "sources")).flatMap((source) => strings([field(source, "url")]));
    case "web_fetch":
      return entries(field(output, "pages")).flatMap((page) =>
        field(page, "status") === "ok" ? [...strings([field(page, "final_url")]), ...strings(field(page, "links"))] : [],
      );
    case "read_conversation":
    case "search_conversations":
      return strings(field(output, "userLinks"));
    case "ask_user":
      return entries(field(output, "answers")).flatMap((answer) => strings([field(answer, "other")]).flatMap(pageLinksIn));
    case "request_space_content":
      return entries(field(output, "spaces")).flatMap((space) => strings([field(space, "content")]).flatMap(pageLinksIn));
    default:
      return [];
  }
}

/**
 * An empty set.
 * @returns The set.
 * @throws {never} Never.
 */
export function makePageLinks(): PageLinks {
  // Each key's first recorded spelling: what is read is what the
  // conversation holds, never what the model added to it.
  const spellings = new Map<string, string>();
  /**
   * Note links by their key, keeping the first spelling of each.
   * @param links - The links.
   */
  const add = (links: readonly string[]): void => {
    for (const link of links) {
      const key = pageLinkKey(link);
      if (!spellings.has(key)) spellings.set(key, /^https?:\/\//i.test(link) ? link : `https://${link}`);
    }
  };
  /**
   * The spelling recorded for a link's key.
   * @param url - The link.
   * @returns The spelling, or undefined when the set does not hold it.
   */
  const urlFor = (url: string): string | undefined => spellings.get(pageLinkKey(url));
  /**
   * Note the links a message the model was sent from the user's side holds.
   * @param message - The message.
   */
  const addUserMessage = (message: ModelMessage): void => {
    for (const text of textsOf(message.content)) add(pageLinksIn(text));
  };
  /**
   * Note the links in the structured fields of one tool's result.
   * @param toolName - The tool.
   * @param output - What it returned.
   */
  const addToolResult = (toolName: string, output: unknown): void => {
    add(linksOfResult(toolName, output));
  };

  return {
    addUserMessage,
    addToolResult,
    addRow(row: ReplayRow): void {
      const sent = entries(field(row.forModel, "messages"));
      if (row.role === "user") {
        // A row written before `forModel` existed holds only what the user typed.
        if (sent.length === 0) {
          for (const part of row.parts) if (part.type === "text") add(pageLinksIn(part.text));
        }
        for (const message of sent) if (field(message, "role") === "user") addUserMessage(message as ModelMessage);
        return;
      }
      for (const part of row.parts) {
        if (part.type === "tool" && part.status === "success") addToolResult(part.toolName, part.output);
      }
      // A card's answer, and the Spaces a request read, are kept only in what
      // the model was sent: the part the card draws from has no Space content.
      // A segment resumed by an answer also keeps the user's side of its
      // opening message here.
      for (const message of sent) {
        if (field(message, "role") === "user") addUserMessage(message as ModelMessage);
        if (field(message, "role") !== "tool") continue;
        for (const result of entries(field(message, "content"))) {
          const output = field(result, "output");
          const toolName = field(result, "toolName");
          if (field(output, "type") === "json" && typeof toolName === "string") {
            addToolResult(toolName, field(output, "value"));
          }
        }
      }
    },
    allows: (url: string): boolean => urlFor(url) !== undefined,
    urlFor,
  };
}

/**
 * The set holding every link of the turns the memory watermark folded away,
 * up to and including it: a link the user gave long ago is still theirs. The
 * turns above the watermark are the turn's history, which its caller adds.
 * @param conversationId - The conversation.
 * @param watermark - The last turn folded into memory.
 * @returns The set.
 * @throws {Error} When the conversation's rows cannot be read.
 */
export async function pageLinksForTurn(conversationId: string, watermark: number): Promise<PageLinks> {
  const links = makePageLinks();
  for (const row of await conversationService.getMessagesForLlm(conversationId, 0, watermark + 1)) links.addRow(row);
  return links;
}
