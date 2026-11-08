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
