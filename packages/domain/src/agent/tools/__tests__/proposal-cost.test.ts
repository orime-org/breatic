// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a placed proposal costs, as the model reads it back (breatic#1361).
 *
 * The agent tells the user what a proposal will spend before they place it,
 * so the line it reads back carries each generation's estimate at the params
 * it was sent with, and the sum, priced the way the panel and the enqueue
 * check price a run: through `estimateModelCredits`.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { formatCredits, setLocale, type ProposalAnswer } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";
import { estimateModelCredits } from "@domain/model-catalog/model-catalog.js";

import { answerFor, makeProposeCanvasAction, renderProposalForModel } from "../propose-canvas-action.js";
import { inputSchema } from "../proposal-input.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** Two takes on one look with no material, each at the lowest settings its model offers. */
const TAKES = {
  nodes: [
    { role: "generate", type: "image", name: "Ink wash", mode: "t2i", model: "nano-banana-2", params: { resolution: "0.5k" }, prompt: [{ text: "A herbalist girl in ink wash." }] },
    { role: "generate", type: "image", name: "Cel shaded", mode: "t2i", model: "gpt-image-2.5-sunburst-text-to-image", params: { quality: "low", resolution: "1k" }, prompt: [{ text: "A herbalist girl, cel shaded." }] },
  ],
  edges: [],
  rationale: "Two looks to choose from.",
  groupName: "Looks",
};

/**
 * The placed answer for the two takes.
 * @returns The answer.
 * @throws {Error} When the proposal is refused.
 */
function placed(): ProposalAnswer {
  const answer = answerFor(inputSchema.parse(TAKES));
  if (!answer.placed) throw new Error(answer.reason);
  return answer;
}

/**
 * Each generate node's estimate at the params it was sent with.
 * @returns The credits of each, in node order.
 * @throws {Error} When the catalog does not price one.
 */
async function sentPrices(): Promise<number[]> {
  return Promise.all(
    TAKES.nodes.map(async (node) => {
      const price = await estimateModelCredits(node.model, { params: node.params });
      if (price === undefined) throw new Error(`${node.model} has no price`);
      return price.credits;
    }),
  );
}

/**
 * What the model reads back for the placed takes, whether the renderer answers
 * at once or after pricing.
 * @returns The text.
 */
async function readBack(): Promise<string> {
  return Promise.resolve(renderProposalForModel(placed()));
}

describe("the cost of a placed proposal, read back to the model", () => {
  it("is priced at the params each node was sent with, not at the model's defaults", async () => {
    // Guards the case itself: were the sent params priced like the defaults,
    // a reading at the defaults would pass too.
    const atDefaults = await estimateModelCredits("nano-banana-2", { params: {} });
    const [sent] = await sentPrices();
    expect(atDefaults?.credits).not.toBe(sent);
  });

  it("says each generate node's estimate at its sent params, by the node's name", async () => {
    const said = await readBack();
    const prices = await sentPrices();
    TAKES.nodes.forEach((node, i) => {
      const line = said.split("\n").find((one) => one.includes(node.name)) ?? "";
      expect(line, node.name).toContain(formatCredits(prices[i] ?? 0, "en-US"));
    });
  });

  it("says the total of every generate node's estimate", async () => {
    const said = await readBack();
    const total = (await sentPrices()).reduce((sum, one) => sum + one, 0);
    expect(said).toContain(formatCredits(total, "en-US"));
    expect(said).toMatch(/total/i);
  });

  it("is what the tool hands the model, through toModelOutput", async () => {
    const proposeTool = makeProposeCanvasAction() as unknown as {
      toModelOutput?: (options: { toolCallId: string; input: unknown; output: ProposalAnswer }) => unknown;
    };
    const output = (await proposeTool.toModelOutput?.({ toolCallId: "t", input: TAKES, output: placed() })) as { value?: unknown } | undefined;
    const total = (await sentPrices()).reduce((sum, one) => sum + one, 0);
    expect(String(output?.value)).toContain(formatCredits(total, "en-US"));
  });

  it("still says the proposal is on screen and the user decides", async () => {
    expect(await readBack()).toContain("The proposal is on screen as a card.");
  });
});

/** Words a voice reads, short enough that their price differs from the rate per 1000 characters. */
const WORDS = "Welcome to the herb garden. Mind the nettles by the gate.";

/** One voice-over whose words are written into its prompt; the TTS model is priced by the length of its text. */
const VOICE = {
  nodes: [{ role: "generate", type: "audio", name: "Voice", mode: "tts", model: "realtime-tts-2", prompt: [{ text: WORDS }] }],
  edges: [],
  rationale: "A voice-over.",
};

/**
 * The placed answer for a proposal.
 * @param sent - What the model sends.
 * @returns The answer.
 * @throws {Error} When the proposal is refused.
 */
function placedOf(sent: unknown): Extract<ProposalAnswer, { placed: true }> {
  const answer = answerFor(inputSchema.parse(sent));
  if (!answer.placed) throw new Error(answer.reason);
  return answer;
}

/**
 * The line of the read-back that states the total, or the empty string.
 * @param said - The read-back.
 * @returns The line.
 */
function totalLine(said: string): string {
  return said.split("\n").find((line) => /^total/i.test(line)) ?? "";
}

describe("the cost read back when a price turns on the words", () => {
  it("prices a voice node from the words written in its prompt", async () => {
    const answer = placedOf(VOICE);
    const params = answer.nodes[0]?.params ?? {};
    const expected = await estimateModelCredits("realtime-tts-2", { params, prompt: WORDS });
    if (expected === undefined) throw new Error("realtime-tts-2 has no price");
    // Guards the case itself: the words price differently from the rate.
    const rate = await estimateModelCredits("realtime-tts-2", { params });
    expect(rate?.bound).toBe("per_thousand_chars");
    expect(expected.bound).not.toBe("per_thousand_chars");
    expect(expected.credits).not.toBe(rate?.credits);
    const line = (await renderProposalForModel(answer)).split("\n").find((one) => one.includes('"Voice"')) ?? "";
    expect(line).toContain(formatCredits(expected.credits, "en-US"));
    expect(line).not.toContain("per 1000 characters");
  });

  it("says no total when the only generation is priced per 1000 characters", async () => {
    const answer = placedOf(VOICE);
    const unwritten = { ...answer, nodes: answer.nodes.map((node) => ({ ...node, prompt: undefined })) };
    const said = await renderProposalForModel(unwritten);
    // Guards the case itself: with no words the node is priced by the rate.
    expect(said).toContain("per 1000 characters");
    expect(said).not.toMatch(/total/i);
  });

  it("says no total when the only generation has no price on this deployment", async () => {
    const answer = placedOf(TAKES);
    const unpriced = { ...answer, nodes: answer.nodes.slice(0, 1).map((node) => ({ ...node, model: "no-such-model" })) };
    const said = await renderProposalForModel(unpriced);
    expect(said).toContain("no price on this deployment");
    expect(said).not.toMatch(/total/i);
  });
});

describe("how the total bounds the charge", () => {
  /** A model that needs a source the read-back cannot measure, so its price is a floor. */
  const EDIT = "gpt-image-2.5-sunburst-edit";

  it("says at least when one generation's price is a floor", async () => {
    const answer = placedOf(TAKES);
    const first = answer.nodes[0];
    if (first === undefined) throw new Error("no node");
    // Guards the case itself: the edit model is priced as a floor, the takes exactly.
    expect((await estimateModelCredits(EDIT, { params: {} }))?.bound).toBe("at_least");
    const mixed = { ...answer, nodes: [...answer.nodes, { ...first, name: "Edit", mode: "i2i", model: EDIT, params: {} }] };
    expect(totalLine(await renderProposalForModel(mixed))).toContain("at least");
  });

  it("says neither about nor at least when every price is exact", async () => {
    for (const node of TAKES.nodes) expect((await estimateModelCredits(node.model, { params: node.params }))?.bound, node.model).toBe("exact");
    const total = totalLine(await readBack());
    expect(total).not.toBe("");
    expect(total).not.toMatch(/about|at least/i);
  });
});
