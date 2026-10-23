// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ModelMessage } from "ai";

import { projectAgentRequest } from "../project-agent-request.js";

type Picture = {
  label: string;
  sourceUrl: string;
  url: string;
  sizeBytes: number;
  mediaType: "image/jpeg";
};

const POLICY = { seesPictures: true, maxPictures: 50, maxBytes: 20_971_520, pictureTokensEstimate: 4784 };

/** A registered JPEG fact, kept independently of this request's budget. */
function picture(index: number, sizeBytes = 100): Picture {
  return {
    label: `Attachment ${String(index + 1)}`,
    sourceUrl: `https://sources.example/${String(index)}.bin`,
    url: `https://media.example/${String(index)}.agent-v1-1024-q85.jpg`,
    sizeBytes,
    mediaType: "image/jpeg",
  };
}

/** One ordinary user file occurrence. */
function userPicture(one: Picture): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: `${one.label}; source: ${one.sourceUrl}` },
      { type: "file", data: one.url, mediaType: one.mediaType },
    ],
  };
}

/** Every ordinary native image that will reach the model, in send order. */
function fileUrls(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => typeof message.content === "string" ? [] : message.content.flatMap((part) => {
    if (part.type !== "file" || !part.mediaType.startsWith("image/")) return [];
    return [String(part.data)];
  }));
}

/** A paired tool call with optional signed reasoning. */
function call(id: string, signed = false): ModelMessage {
  return {
    role: "assistant",
    content: [
      ...(signed ? [{ type: "reasoning" as const, text: `thinking ${id}`, providerOptions: { anthropic: { signature: id } } }] : []),
      { type: "tool-call", toolCallId: id, toolName: "search_images", input: { query: id } },
    ],
  };
}

/** A tool result carrying only the project's serializable picture facts. */
function result(id: string, pictures: readonly Picture[]): ModelMessage {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: id,
      toolName: "search_images",
      output: { type: "json", value: { kind: "agent-pictures-v1", text: `Results ${id}`, pictures: [...pictures] } },
    }],
  };
}

/** A deterministic stand-in for the caller's request-prefix digest. */
function hash(messages: readonly ModelMessage[]): string {
  return JSON.stringify(messages);
}

/** Whether signed thinking or other private provider state is still present. */
function carriesThinking(messages: readonly ModelMessage[]): boolean {
  return /"reasoning"|"reasoning-file"|"custom"|"providerOptions"/.test(JSON.stringify(messages));
}

describe("the single Agent request picture projection", () => {
  it("keeps fifty ordinary pictures and their order at the default count boundary", () => {
    const pictures = Array.from({ length: 50 }, (_, index) => picture(index));
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: POLICY, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual(pictures.map((one) => one.url));
    expect(projected.keptPictures).toEqual(pictures);
    expect(projected.changedMessageIndices).toEqual([]);
  });

  it("drops the oldest full half-batch once the normal count is exceeded", () => {
    const pictures = Array.from({ length: 51 }, (_, index) => picture(index));
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: POLICY, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual(pictures.slice(25).map((one) => one.url));
    expect(projected.changedMessageIndices).toEqual(Array.from({ length: 25 }, (_, index) => index));
    for (const one of pictures.slice(0, 25)) {
      expect(JSON.stringify(projected.messages)).toContain(one.label);
      expect(JSON.stringify(projected.messages)).toContain(one.sourceUrl);
    }
    expect(JSON.stringify(projected.messages)).toContain("understand_media");
  });

  it("drops multiple complete batches rather than truncating to the normal maximum", () => {
    const pictures = Array.from({ length: 76 }, (_, index) => picture(index));
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: POLICY, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual(pictures.slice(50).map((one) => one.url));
  });

  it("uses the higher step count boundary after tools append their pictures", () => {
    const pictures = Array.from({ length: 5 }, (_, index) => picture(index));
    const messages = [userPicture(pictures[0]!), userPicture(pictures[1]!), call("c1"), result("c1", pictures.slice(2))];
    const projected = projectAgentRequest({ messages, pictures, policy: { ...POLICY, maxPictures: 2 }, phase: "step" });

    expect(fileUrls(projected.messages)).toEqual(pictures.slice(1).map((one) => one.url));
    expect(projected.keptPictures).toEqual(pictures.slice(1));
  });

  it("never widens the provider count boundary beyond one hundred", () => {
    const pictures = Array.from({ length: 101 }, (_, index) => picture(index));
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: { ...POLICY, maxPictures: 80 }, phase: "step" });

    expect(fileUrls(projected.messages)).toEqual(pictures.slice(40).map((one) => one.url));
  });

  it("counts repeated occurrences of one JPEG separately", () => {
    const one = picture(0);
    const projected = projectAgentRequest({
      messages: [userPicture(one), userPicture(one), userPicture(one)],
      pictures: [one],
      policy: { ...POLICY, maxPictures: 2 },
      phase: "initial",
    });

    expect(fileUrls(projected.messages)).toEqual([one.url, one.url]);
    expect(projected.changedMessageIndices).toEqual([0]);
  });

  it("drops oldest count batches until bytes are at most half after overflow", () => {
    const pictures = Array.from({ length: 5 }, (_, index) => picture(index, 30));
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: { ...POLICY, maxPictures: 4, maxBytes: 100 }, phase: "step" });

    expect(fileUrls(projected.messages)).toEqual([pictures[4]!.url]);
    expect(projected.keptPictures.reduce((sum, one) => sum + one.sizeBytes, 0)).toBe(30);
  });

  it("keeps bytes exactly at the limit without prematurely halving", () => {
    const pictures = [picture(0, 40), picture(1, 60)];
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: { ...POLICY, maxBytes: 100 }, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual(pictures.map((one) => one.url));
  });

  it("marks an individually oversized JPEG unavailable before selecting the remaining pictures", () => {
    const pictures = [picture(0, 101), picture(1, 60)];
    const projected = projectAgentRequest({ messages: pictures.map(userPicture), pictures, policy: { ...POLICY, maxBytes: 100 }, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual([pictures[1]!.url]);
    expect(JSON.stringify(projected.messages[0])).toContain(pictures[0]!.sourceUrl);
    expect(JSON.stringify(projected.messages[0])).toMatch(/unavailable|exceed|too large/i);
  });

  it("does not treat an unknown image byte size as zero", () => {
    const one = picture(0);
    const projected = projectAgentRequest({ messages: [userPicture(one)], pictures: [], policy: POLICY, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual([]);
    expect(JSON.stringify(projected.messages)).toContain(one.url);
    expect(JSON.stringify(projected.messages)).toMatch(/unavailable|metadata|size|unknown/i);
  });

  it("removes current native files and tool pictures together for a model without vision", () => {
    const pictures = [picture(0), picture(1)];
    const messages = [userPicture(pictures[0]!), call("c1"), result("c1", [pictures[1]!])];
    const projected = projectAgentRequest({ messages, pictures, policy: { ...POLICY, seesPictures: false }, phase: "initial" });

    expect(fileUrls(projected.messages)).toEqual([]);
    expect(projected.keptPictures).toEqual([]);
    for (const one of pictures) expect(JSON.stringify(projected.messages)).toContain(one.sourceUrl);
    expect(JSON.stringify(projected.messages)).toContain("understand_media");
    expect(JSON.stringify(projected.logicalMessages)).not.toContain('"pictures":[{');
  });

  it("does not mutate stored logical facts and restores pictures when the next turn relaxes the count", () => {
    const pictures = [picture(0), picture(1), picture(2)];
    const messages = pictures.map(userPicture);
    const before = JSON.stringify({ messages, pictures });
    const small = projectAgentRequest({ messages, pictures, policy: { ...POLICY, maxPictures: 2 }, phase: "initial" });
    const larger = projectAgentRequest({ messages, pictures, policy: { ...POLICY, maxPictures: 4 }, phase: "initial" });

    expect(fileUrls(small.messages)).toEqual(pictures.slice(1).map((one) => one.url));
    expect(fileUrls(larger.messages)).toEqual(pictures.map((one) => one.url));
    expect(JSON.stringify({ messages, pictures })).toBe(before);
    expect(small.messages).not.toBe(messages);
    expect(small.logicalMessages).not.toBe(messages);
  });

  it("restores original facts after byte-budget or vision-policy changes next turn", () => {
    const pictures = [picture(0, 60), picture(1, 60)];
    const messages = pictures.map(userPicture);
    const low = projectAgentRequest({ messages, pictures, policy: { ...POLICY, maxPictures: 2, maxBytes: 100 }, phase: "initial" });
    const blind = projectAgentRequest({ messages, pictures, policy: { ...POLICY, seesPictures: false }, phase: "initial" });
    const restored = projectAgentRequest({ messages, pictures, policy: POLICY, phase: "initial" });

    expect(fileUrls(low.messages)).toEqual([]);
    expect(fileUrls(blind.messages)).toEqual([]);
    expect(fileUrls(restored.messages)).toEqual(pictures.map((one) => one.url));
  });

  it("expands all contiguous tool results before inserting their pictures as one user message", () => {
    const pictures = [picture(0), picture(1)];
    const calls: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "search_images", input: { query: "one" } },
        { type: "tool-call", toolCallId: "c2", toolName: "search_images", input: { query: "two" } },
      ],
    };
    const messages = [calls, result("c1", [pictures[0]!]), result("c2", [pictures[1]!])];
    const projected = projectAgentRequest({ messages, pictures, policy: POLICY, phase: "step" });

    expect(projected.messages.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(fileUrls(projected.messages)).toEqual(pictures.map((one) => one.url));
    const expansion = JSON.stringify(projected.messages[3]);
    expect(expansion).toContain("c1");
    expect(expansion).toContain("c2");
    expect(expansion.indexOf(pictures[0]!.label)).toBeLessThan(expansion.indexOf(pictures[1]!.label));
    expect(projected.logicalMessages).toEqual(messages);
  });

  it("expanding an already projected request does not duplicate tool pictures", () => {
    const pictures = [picture(0), picture(1)];
    const once = projectAgentRequest({ messages: [call("c1"), result("c1", pictures)], pictures, policy: POLICY, phase: "step" });
    const twice = projectAgentRequest({ messages: once.messages, pictures, policy: POLICY, phase: "step" });

    expect(twice.messages).toEqual(once.messages);
    expect(fileUrls(twice.messages)).toEqual(pictures.map((one) => one.url));
  });

  it("preserves old text tool results without interpretation or implicit picture imports", () => {
    const messages: ModelMessage[] = [
      call("old"),
      { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "search_images", output: { type: "text", value: "image: https://legacy.example/a.png" } }] },
    ];
    const projected = projectAgentRequest({ messages, pictures: [], policy: POLICY, phase: "initial" });

    expect(projected.messages).toEqual(messages);
    expect(projected.keptPictures).toEqual([]);
  });

  it("is deterministic and always respects count and byte bounds for mixed native and tool pictures", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 200 }), { maxLength: 35 }),
      fc.integer({ min: 2, max: 12 }),
      fc.integer({ min: 1, max: 1000 }),
      fc.boolean(),
      (sizes, maxPictures, maxBytes, seesPictures) => {
        const pictures = sizes.map((size, index) => picture(index, size));
        const split = Math.floor(pictures.length / 2);
        const messages = [...pictures.slice(0, split).map(userPicture), call("mixed"), result("mixed", pictures.slice(split))];
        const request = { messages, pictures, policy: { ...POLICY, maxPictures, maxBytes, seesPictures }, phase: "initial" as const };
        const before = JSON.stringify(request);
        const first = projectAgentRequest(request);
        const second = projectAgentRequest(request);

        expect(first.messages).toEqual(second.messages);
        expect(first.keptPictures.length).toBeLessThanOrEqual(seesPictures ? maxPictures : 0);
        expect(first.keptPictures.reduce((sum, one) => sum + one.sizeBytes, 0)).toBeLessThanOrEqual(maxBytes);
        expect(fileUrls(first.messages)).toEqual(first.keptPictures.map((one) => one.url));
        expect(JSON.stringify(request)).toBe(before);
      },
    ), { seed: 1669, numRuns: 100 });
  });
});

describe("thinking is checked independently against each actual generation prefix", () => {
  it("clears first-step reasoning when a newly returned picture removes an earlier input", () => {
    const pictures = Array.from({ length: 5 }, (_, index) => picture(index));
    const before = pictures.slice(0, 2).map(userPicture);
    const response = [call("c1", true), result("c1", pictures.slice(2))];
    const projected = projectAgentRequest({
      messages: [...before, ...response], pictures, policy: { ...POLICY, maxPictures: 2 }, phase: "step",
      steps: [{ messageStart: 2, messageEnd: 4, prefixHash: hash(before) }], prefixHash: hash,
    });

    expect(fileUrls(projected.messages)).toEqual(pictures.slice(1).map((one) => one.url));
    expect(carriesThinking(projected.messages)).toBe(false);
    expect(JSON.stringify(projected.messages)).toContain('"toolCallId":"c1"');
    expect(projected.logicalMessages[2]).toEqual(call("c1"));
  });

  it("clears a step whose own tool-picture body was rewritten even if its input prefix still matches", () => {
    const pictureFacts = [picture(0, 101)];
    const before: ModelMessage[] = [{ role: "user", content: "search" }];
    const projected = projectAgentRequest({
      messages: [...before, call("c1", true), result("c1", pictureFacts)], pictures: pictureFacts,
      policy: { ...POLICY, maxBytes: 100 }, phase: "step",
      steps: [{ messageStart: 1, messageEnd: 3, prefixHash: hash(before) }], prefixHash: hash,
    });

    expect(carriesThinking(projected.messages)).toBe(false);
    expect(fileUrls(projected.messages)).toEqual([]);
    expect(projected.logicalMessages[1]).toEqual(call("c1"));
  });

  it("keeps a later step generated under the already stripped and projected prefix", () => {
    const one = picture(0);
    const oldQuestion = userPicture(one);
    const plainQuestion: ModelMessage = { role: "user", content: "projected question" };
    const firstStep = call("c1", true);
    const firstResult = result("c1", []);
    const later: ModelMessage = {
      role: "assistant",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      content: [
        { type: "reasoning", text: "valid later thought", providerOptions: { anthropic: { signature: "later" } } },
        { type: "text", text: "done" },
      ],
    };
    const validLaterPrefix = [plainQuestion, call("c1"), firstResult];
    const projected = projectAgentRequest({
      messages: [plainQuestion, firstStep, firstResult, later], pictures: [one], policy: POLICY, phase: "step",
      steps: [
        { messageStart: 1, messageEnd: 3, prefixHash: hash([oldQuestion]) },
        { messageStart: 3, messageEnd: 4, prefixHash: hash(validLaterPrefix) },
      ], prefixHash: hash,
    });

    expect(projected.logicalMessages[1]).toEqual(call("c1"));
    expect(projected.logicalMessages[3]).toEqual(later);
    expect(carriesThinking([projected.messages.at(-1)!])).toBe(true);
  });

  it("strips all provider options on a mismatching step while preserving calls and answers", () => {
    const question: ModelMessage = { role: "user", content: "q" };
    const signedCall: ModelMessage = {
      role: "assistant", providerOptions: { openrouter: { raw: "message-secret" } },
      content: [
        { type: "reasoning", text: "hidden" },
        { type: "tool-call", toolCallId: "c1", toolName: "search_images", input: { query: "q" }, providerOptions: { openrouter: { reasoning_details: [{ signature: "private" }] } } },
      ],
    };
    const toolResult = result("c1", []);
    const projected = projectAgentRequest({
      messages: [question, signedCall, toolResult], pictures: [], policy: POLICY, phase: "step",
      steps: [{ messageStart: 1, messageEnd: 3, prefixHash: "different actual prefix" }], prefixHash: hash,
    });

    expect(carriesThinking(projected.messages)).toBe(false);
    expect(projected.logicalMessages[1]).toEqual({ role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "search_images", input: { query: "q" } }] });
    expect(projected.logicalMessages[2]).toEqual(toolResult);
  });
});
