// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { LanguageModelMiddleware } from "ai";
import {
  AGENT_TOOL_PICTURE_MARKER,
  agentPictureLabelFor,
  agentPictureOutputOf,
} from "@domain/agent/project-agent-request.js";

/** The final SDK prompt, after the application's sole budget projection. */
type Prompt = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"]["prompt"];
/** User content at the provider boundary uses tagged URL data. */
type UserParts = Extract<Prompt[number], { role: "user" }>["content"];

/** Only versioned, prepared HTTPS JPEG URLs are added to a model's URL support. */
const PREPARED_JPEG_URL = /^https:\/\/[^\s]+\.agent-v1-\d+-q\d+\.jpg$/;

/**
 * Copy one SDK message while preserving URL and byte data types.
 * @param message - A message already converted to provider format.
 * @returns An independent message and content array.
 * @throws {DOMException} When a provider value cannot be cloned.
 */
function copyMessage(message: Prompt[number]): Prompt[number] {
  if (message.role === "system") return { ...message };
  const content = message.content.map((part) => {
    if (part.type === "file" && part.data.type === "url") {
      return { ...part, data: { ...part.data, url: new URL(part.data.url) } };
    }
    return structuredClone(part);
  });
  return { ...message, content } as Prompt[number];
}

/**
 * Expand already selected logical tool results at the provider boundary.
 * @param prompt - The SDK prompt with its complete tool-result groups.
 * @returns Fresh messages with deterministic picture user messages.
 * @throws {DOMException} When a provider value cannot be cloned.
 */
function expandPrompt(prompt: Prompt): Prompt {
  const logical = prompt.filter((message) => !(message.role === "user" &&
    message.content[0]?.type === "text" && message.content[0].text === AGENT_TOOL_PICTURE_MARKER));
  const out: Prompt = [];
  let pending: UserParts = [];
  for (let index = 0; index < logical.length; index += 1) {
    const message = copyMessage(logical[index]!);
    out.push(message);
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const descriptor = agentPictureOutputOf(part.output);
      for (const picture of descriptor?.pictures ?? []) {
        pending.push(
          { type: "text", text: agentPictureLabelFor(part.toolCallId, picture) },
          { type: "file", mediaType: "image/jpeg", data: { type: "url", url: new URL(picture.url) } },
        );
      }
    }
    if (logical[index + 1]?.role !== "tool" && pending.length > 0) {
      out.push({ role: "user", content: [{ type: "text", text: AGENT_TOOL_PICTURE_MARKER }, ...pending] });
      pending = [];
    }
  }
  return out;
}

/**
 * Sending-only adaptation. Budget and thinking selection remain in projection.
 * Prepared JPEG bytes stay at storage and tool images follow all paired results.
 */
export const pictureMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  overrideSupportedUrls: async ({ model }): Promise<Record<string, RegExp[]>> => {
    const supported = await model.supportedUrls ?? {};
    return { ...supported, "image/*": [...(supported["image/*"] ?? []), PREPARED_JPEG_URL] };
  },
  transformParams: async ({ params }): Promise<typeof params> => ({ ...params, prompt: expandPrompt(params.prompt) }),
};
