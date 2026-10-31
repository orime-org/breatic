// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ModelMessage, UserContent } from "ai";

/** Durable facts about a prepared JPEG. No SDK or provider payload is stored. */
export type AgentPicture = {
  label: string;
  sourceUrl: string;
  url: string;
  sizeBytes: number;
  mediaType: "image/jpeg";
};

/** The fixed picture policy for one turn. */
export interface AgentPicturePolicy {
  seesPictures: boolean;
  maxPictures: number;
  maxBytes: number;
  pictureTokensEstimate: number;
}

/** One completed model step and the actual prefix under which it was made. */
export interface AgentGenerationStep {
  messageStart: number;
  messageEnd: number;
  prefixHash: string;
}

/** The project's serializable tool-picture result. */
export type AgentPictureOutput = {
  kind: "agent-pictures-v1";
  text: string;
  pictures: AgentPicture[];
};

/** Inputs to the sole request projection, independent of storage and providers. */
export interface AgentRequestProjection {
  messages: readonly ModelMessage[];
  pictures: readonly AgentPicture[];
  policy: AgentPicturePolicy;
  phase: "initial" | "step";
  steps?: readonly AgentGenerationStep[];
  prefixHash?: (messages: readonly ModelMessage[]) => string;
}

/** Both representations of one projected request and its changed logical rows. */
export interface ProjectedAgentRequest {
  messages: ModelMessage[];
  logicalMessages: ModelMessage[];
  changedMessageIndices: number[];
  keptPictures: AgentPicture[];
}

/** A versioned seed component, changed whenever wire expansion rules change. */
export const AGENT_PICTURE_PROJECTION_VERSION = 1;
export const AGENT_TOOL_PICTURE_MARKER = "[Agent pictures from tool results]";
const THINKING = new Set(["reasoning", "reasoning-file", "custom"]);

/**
 * Read the project's tool JSON without interpreting arbitrary legacy results.
 * @param output - A tool-result output.
 * @returns Its versioned picture descriptor, when present.
 * @throws {never} Never.
 */
export function agentPictureOutputOf(output: unknown): AgentPictureOutput | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const wrapped = output as { type?: unknown; value?: unknown };
  if (wrapped.type !== "json" || typeof wrapped.value !== "object" || wrapped.value === null) return undefined;
  const value = wrapped.value as Partial<AgentPictureOutput>;
  return value.kind === "agent-pictures-v1" && typeof value.text === "string" && Array.isArray(value.pictures)
    ? value as AgentPictureOutput : undefined;
}

/**
 * Whether a message is a deterministic expansion already made by this module.
 * @param message - One SDK message.
 * @returns Whether it is an expanded tool-picture message.
 * @throws {never} Never.
 */
function isExpansion(message: ModelMessage): boolean {
  return message.role === "user" && Array.isArray(message.content) &&
    message.content[0]?.type === "text" && message.content[0].text === AGENT_TOOL_PICTURE_MARKER;
}

/**
 * Expand prepared tool pictures after the complete contiguous tool-result group.
 * @param messages - Already selected logical messages.
 * @returns A fresh SDK message array with deterministic user-picture messages.
 * @throws {never} Never.
 */
export function expandAgentPictures(messages: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let pending: Exclude<UserContent, string> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (isExpansion(message)) continue;
    out.push(message);
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type !== "tool-result") continue;
        const descriptor = agentPictureOutputOf(part.output);
        if (descriptor === undefined) continue;
        for (const picture of descriptor.pictures) {
          pending.push(
            { type: "text", text: agentPictureLabelFor(part.toolCallId, picture) },
            { type: "file", data: picture.url, mediaType: "image/jpeg" },
          );
        }
      }
    }
    if (message.role === "tool" && messages[index + 1]?.role !== "tool" && pending.length > 0) {
      out.push({ role: "user", content: [{ type: "text", text: AGENT_TOOL_PICTURE_MARKER }, ...pending] });
      pending = [];
    }
  }
  return out;
}

/**
 * Use the same visible label in logical projection and provider adaptation.
 * @param toolCallId - The tool call that supplied the picture.
 * @param picture - Its prepared source facts.
 * @returns Deterministic source and call attribution.
 * @throws {never} Never.
 */
export function agentPictureLabelFor(toolCallId: string, picture: AgentPicture): string {
  return `Tool ${toolCallId}; ${picture.label}; source: ${picture.sourceUrl}`;
}

/**
 * Preserve a picture's source and a useful next action when it is not visible.
 * @param picture - Known source facts.
 * @param reason - Why this request cannot include it.
 * @returns The text replacing this picture occurrence.
 * @throws {never} Never.
 */
function placeholder(picture: Pick<AgentPicture, "label" | "sourceUrl">, reason?: string): string {
  return `[Picture ${reason === undefined ? "omitted from this request" : `unavailable: ${reason}`}: ${picture.label}; source: ${picture.sourceUrl}; use understand_media to inspect it again.]`;
}

/**
 * Remove reasoning and every provider option while keeping protocol facts.
 * @param message - A logical message in an invalidated generation step.
 * @returns Its provider-independent representation, or none when empty.
 * @throws {never} Never.
 */
function withoutThinking(message: ModelMessage): ModelMessage | null {
  const { providerOptions: _removed, ...rest } = message;
  if (typeof rest.content === "string") return rest;
  const content = rest.content.filter((part) => !THINKING.has(part.type)).map((part) => {
    const { providerOptions: _private, ...safe } = part as { type: string; providerOptions?: unknown };
    return safe;
  });
  if (rest.role === "assistant" && content.length === 0) return null;
  return { ...rest, content } as ModelMessage;
}

/** A picture occurrence and its independently checked eligibility. */
interface Occurrence {
  picture: AgentPicture;
  reason?: string;
  keep: boolean;
}

/**
 * Describe one occurrence without treating unknown sizes as free pictures.
 * @param picture - Facts from persistence or tool execution.
 * @param policy - Fixed turn policy.
 * @returns The occurrence's initial eligibility.
 * @throws {never} Never.
 */
function occurrenceFor(picture: AgentPicture, policy: AgentPicturePolicy): Occurrence {
  let reason: string | undefined;
  if (!Number.isSafeInteger(picture.sizeBytes) || picture.sizeBytes <= 0) reason = "unknown byte size metadata";
  else if (picture.sizeBytes > policy.maxBytes) reason = "JPEG exceeds request byte limit";
  else if (picture.mediaType !== "image/jpeg" || !/^https:\/\//.test(picture.url)) reason = "invalid prepared JPEG metadata";
  else if (!policy.seesPictures) reason = "the current model cannot see pictures";
  return { picture, ...(reason === undefined ? {} : { reason }), keep: reason === undefined };
}

/**
 * Project all native and tool pictures with one budget, then check each step.
 * @param request - Logical facts, fixed policy and generation-prefix records.
 * @returns Fresh logical and expanded messages; durable input stays untouched.
 * @throws {DOMException} When input contains nonserializable provider values.
 */
export function projectAgentRequest(request: AgentRequestProjection): ProjectedAgentRequest {
  const { policy } = request;
  const logical = structuredClone(request.messages.filter((message) => !isExpansion(message)));
  const facts = new Map<string, AgentPicture[]>();
  for (const picture of request.pictures) {
    const sameUrl = facts.get(picture.url) ?? [];
    sameUrl.push(picture);
    facts.set(picture.url, sameUrl);
  }
  const occurrences: Occurrence[] = [];
  for (const message of logical) {
    if (typeof message.content === "string") continue;
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        const url = String(part.data);
        const candidates = facts.get(url) ?? [];
        const attribution = message.content[partIndex - 1];
        // The adjacent durable label identifies this occurrence even when an
        // earlier occurrence has already become a placeholder in an SDK step.
        const picture = candidates.find((one) => attribution?.type === "text" &&
          attribution.text === `${one.label}; source: ${one.sourceUrl}`) ?? candidates[0] ??
          { label: "Picture", sourceUrl: url, url, mediaType: "image/jpeg", sizeBytes: 0 };
        occurrences.push(occurrenceFor(picture, policy));
      } else if (part.type === "tool-result") {
        for (const picture of agentPictureOutputOf(part.output)?.pictures ?? []) occurrences.push(occurrenceFor(picture, policy));
      }
    }
  }
  const eligible = occurrences.filter((one) => one.keep);
  const batch = Math.max(1, Math.floor(policy.maxPictures / 2));
  const maximum = request.phase === "step" ? Math.min(2 * policy.maxPictures, 100) : policy.maxPictures;
  let drop = eligible.length > maximum ? Math.ceil((eligible.length - maximum) / batch) * batch : 0;
  let bytes = eligible.slice(drop).reduce((sum, one) => sum + one.picture.sizeBytes, 0);
  if (bytes > policy.maxBytes) {
    while (bytes > policy.maxBytes / 2 && drop < eligible.length) {
      drop += batch;
      bytes = eligible.slice(drop).reduce((sum, one) => sum + one.picture.sizeBytes, 0);
    }
  }
  for (const one of eligible.slice(0, drop)) one.keep = false;

  const changed = new Set<number>();
  let cursor = 0;
  const projected = logical.map((message, index): ModelMessage | null => {
    if (typeof message.content === "string") return message;
    const content = message.content.flatMap((part): unknown[] => {
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        const one = occurrences[cursor++]!;
        if (one.keep) return [part];
        changed.add(index);
        return [{ type: "text", text: placeholder(one.picture, one.reason) }];
      }
      if (part.type !== "tool-result") return [part];
      const descriptor = agentPictureOutputOf(part.output);
      if (descriptor === undefined) return [part];
      const pictures: AgentPicture[] = [];
      const omitted: string[] = [];
      for (let count = 0; count < descriptor.pictures.length; count += 1) {
        const one = occurrences[cursor++]!;
        if (one.keep) pictures.push(one.picture);
        else omitted.push(placeholder(one.picture, one.reason));
      }
      if (omitted.length === 0) return [part];
      changed.add(index);
      return [{ ...part, output: { type: "json", value: { ...descriptor, text: [descriptor.text, ...omitted].join("\n"), pictures } } }];
    });
    return { ...message, content } as ModelMessage;
  });
  if (request.prefixHash !== undefined) {
    for (const step of request.steps ?? []) {
      const before = projected.slice(0, step.messageStart).filter((message): message is ModelMessage => message !== null);
      const ownChanged = [...changed].some((index) => index >= step.messageStart && index < step.messageEnd);
      if (!ownChanged && request.prefixHash(expandAgentPictures(before)) === step.prefixHash) continue;
      for (let index = step.messageStart; index < Math.min(step.messageEnd, projected.length); index += 1) {
        const message = projected[index];
        if (message === undefined || message === null) continue;
        const safe = withoutThinking(message);
        if (JSON.stringify(safe) !== JSON.stringify(message)) changed.add(index);
        projected[index] = safe;
      }
    }
  }
  const logicalMessages = projected.filter((message): message is ModelMessage => message !== null);
  return {
    logicalMessages,
    messages: structuredClone(expandAgentPictures(logicalMessages)),
    keptPictures: occurrences.filter((one) => one.keep).map((one) => one.picture),
    changedMessageIndices: [...changed].sort((a, b) => a - b),
  };
}
