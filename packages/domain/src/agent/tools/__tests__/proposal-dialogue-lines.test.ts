// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A dialogue the agent proposes, sent as lines (inner#1825 design 8.5): one
 * per turn, each naming its speaker by number and carrying only the words.
 * The check reads the lines wherever it reads a prompt, prices the script the
 * model is sent, and the listing and the guide say how to send one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import * as shared from "@breatic/shared";
import { formatCredits, proposalMarkSegments, setLocale, t, type ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";

import { generationModels, renderGenerationModelsForModel, type PricedModelsForMode } from "../generation-models.js";
import { renderProductGuide } from "../product-guide.js";
import { answerFor, renderProposalForModel, verdictFor, type MaterialTable } from "../propose-canvas-action.js";
import { inputSchema } from "../proposal-input.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** What the model sends, as the tool's input. */
type Sent = Parameters<typeof verdictFor>[0];

const DUO = "gemini-3.1-flash-text-to-speech";
const PAIR = [{ speaker: "Ava", voice: "Kore" }, { speaker: "Leo", voice: "Puck" }];
const NO_MATERIAL: MaterialTable = new Map();

/**
 * A dialogue proposal on the Gemini speech model.
 * @param lines - Its lines.
 * @param rest - Anything else on the node.
 * @returns What the model sends.
 */
function dialogue(lines: Array<{ speaker: number; prompt: ProposalNode["prompt"] }>, rest: Record<string, unknown> = {}): Sent {
  return {
    nodes: [{ role: "generate", type: "audio", name: "Scene", mode: "tts", model: DUO, params: { speakers: PAIR }, lines, ...rest } as Sent["nodes"][number]],
    edges: [],
    rationale: "A dialogue.",
    groupName: "Dialogue",
  };
}

const TWO = dialogue([{ speaker: 1, prompt: [{ text: "Hi." }] }, { speaker: 2, prompt: [{ text: "Hello." }] }]);

describe("a dialogue sent as lines", () => {
  it("passes the tool's schema and the check", () => {
    expect(inputSchema.safeParse(TWO).success).toBe(true);
    expect(verdictFor(TWO, NO_MATERIAL)).toEqual({ ok: true });
  });

  it("is read for marks line by line, after any prompt", () => {
    const node = { role: "generate", type: "audio", name: "Scene", lines: [{ speaker: 1, prompt: [{ text: "a" }] }, { speaker: 2, prompt: [{ text: "b" }] }] } as unknown as ProposalNode;
    expect(proposalMarkSegments(node)).toEqual([{ text: "a" }, { text: "b" }]);
  });

  it("refuses a line holding only characters the model never receives, as the panel would", () => {
    const verdict = verdictFor(dialogue([{ speaker: 1, prompt: [{ text: "Hi." }] }, { speaker: 2, prompt: [{ text: "\u200B" }] }]), NO_MATERIAL);
    expect(verdict.ok ? "ok" : verdict.refusal).toBe("line-empty");
  });

  it("refuses a dialogue whose speakers are not all named, as the panel would", () => {
    const verdict = verdictFor(dialogue([{ speaker: 1, prompt: [{ text: "Hi." }] }], { params: { speakers: [PAIR[0], { speaker: " ", voice: "Puck" }] } }), NO_MATERIAL);
    expect(verdict.ok ? "ok" : verdict.refusal).toBe("speakers-missing");
  });
});

describe("the price of a dialogue read back", () => {
  it("is priced on the script the model is sent: each line after its speaker's name", async () => {
    const first = "We should leave before the tide comes in over the causeway.";
    const second = "Then pack the lamps and the rope, and leave the rest behind.";
    const sent = dialogue([{ speaker: 1, prompt: [{ text: first }] }, { speaker: 2, prompt: [{ text: second }] }]);
    const answer = answerFor(inputSchema.parse(sent));
    if (!answer.placed) throw new Error(answer.reason);
    const script = (shared as unknown as { dialogueText: (lines: unknown[], speakers: unknown[]) => string }).dialogueText([{ speaker: 1, text: first }, { speaker: 2, text: second }], PAIR);
    const priced = await estimateModelCredits(DUO, { params: { speakers: PAIR }, prompt: script });
    const bare = await estimateModelCredits(DUO, { params: { speakers: PAIR }, prompt: first + second });
    // Guards the case itself: the names must change the price.
    expect(priced?.credits).not.toBe(bare?.credits);
    const said = await renderProposalForModel(answer);
    expect(said).toContain(formatCredits(priced?.credits ?? -1, "en-US"));
  });
});

describe("how a dialogue is sent, as the model listing says it", () => {
  it("tells the agent on the dialogue model's line to send lines, each a speaker from 1 and words only, and no prompt", async () => {
    const execute = (generationModels as unknown as { execute: (i: unknown, o: object) => Promise<PricedModelsForMode> }).execute;
    const lines = renderGenerationModelsForModel(await execute({ nodeType: "audio", mode: "tts" }, {})).split("\n");
    const line = lines.find((one) => one.includes(`(${DUO})`)) ?? "";
    expect(line).not.toBe("");
    expect(line).toMatch(/\blines\b/);
    expect(line).toMatch(/speaker/);
    expect(line).toMatch(/from 1/);
    expect(line).toMatch(/leave prompt out/);
    expect(line).toMatch(/no name/i);
    // A model reading in one voice is told nothing of lines.
    const single = lines.find((one) => one.includes("(realtime-tts-2)")) ?? "";
    expect(single).not.toMatch(/\blines\b/);
  });
});

describe("the product guide on a dialogue", () => {
  it("no longer teaches writing `Name: line` into the prompt", () => {
    const text = renderProductGuide();
    expect(text).not.toContain("write the prompt that way");
    expect(text).not.toMatch(/Name: line/);
  });

  it("leaves no `Name: line` note under the speaker rows in any language", () => {
    for (const locale of ["en", "ja", "ko", "zh-CN", "zh-TW"]) {
      const messages = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../../../locales", `${locale}.json`), "utf-8")) as { canvas: { generatePanel: Record<string, unknown> } };
      expect(messages.canvas.generatePanel, locale).not.toHaveProperty("audioSpeakersNote");
      expect(messages.canvas.generatePanel, locale).toHaveProperty("refuseExecuteNoLines");
    }
  });

  it("names the refusal for a dialogue with no line written", () => {
    expect(renderProductGuide()).toContain(t("canvas.generatePanel.refuseExecuteNoLines"));
  });
});
