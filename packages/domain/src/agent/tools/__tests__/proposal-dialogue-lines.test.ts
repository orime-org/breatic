// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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
import { answerFor, checkedAnswerFor, renderProposalForModel, verdictFor, type MaterialTable } from "../propose-canvas-action.js";
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

const DUO = "gemini-3.8-flash-text-to-speech";
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

describe("a dialogue its upstream cannot take (#1521)", () => {
  /**
   * A dialogue of this many lines, the two speakers taking turns.
   * @param n - How many lines.
   * @returns What the model sends.
   */
  const lines = (n: number): Sent => dialogue(Array.from({ length: n }, (_, i) => ({ speaker: (i % 2) + 1, prompt: [{ text: `Line ${String(i)}.` }] })));

  it("is refused before it is placed, naming the limit it breaks", async () => {
    const answer = await checkedAnswerFor(lines(101), NO_MATERIAL);
    expect(answer.placed).toBe(false);
    expect(answer.placed === false && answer.reason).toMatch(/"Scene".*100 lines/);
  });

  it("is placed when every upstream limit holds", async () => {
    expect((await checkedAnswerFor(lines(100), NO_MATERIAL)).placed).toBe(true);
  });

  it("refuses a single voice past WaveSpeed's 8000 characters", async () => {
    const one: Sent = { nodes: [{ role: "generate", type: "audio", name: "Read", mode: "tts", model: DUO, params: {}, prompt: [{ text: "x".repeat(8001) }] }], edges: [], rationale: "A reading." };
    const answer = await checkedAnswerFor(one, NO_MATERIAL);
    expect(answer.placed === false && answer.reason).toMatch(/"Read".*8000 characters/);
  });

  it("asks about a single voice as it is sent, without the speakers it keeps for the dialogue side", async () => {
    const narration = Array.from({ length: 120 }, (_, i) => `Line ${String(i)}.`).join("\n");
    const one: Sent = { nodes: [{ role: "generate", type: "audio", name: "Read", mode: "tts", model: DUO, params: { speakers: [{ speaker: "Ava", voice: "Nobody" }, { speaker: "Leo", voice: "Nobody" }] }, prompt: [{ text: narration }] }], edges: [], rationale: "A reading." };
    expect(await checkedAnswerFor(one, NO_MATERIAL)).toMatchObject({ placed: true });
  });
});

describe("the price of a dialogue read back", () => {
  it("is priced on the script the model is sent: each line after its speaker's name", async () => {
    // Long enough to be priced past the upstream's per-run minimum, so the names show in the price.
    const first = "We should leave before the tide comes in over the causeway. ".repeat(10).trim();
    const second = "Then pack the lamps and the rope, and leave the rest behind. ".repeat(10).trim();
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
