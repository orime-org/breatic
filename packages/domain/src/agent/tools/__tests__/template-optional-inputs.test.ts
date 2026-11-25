// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A template input the user may leave empty (inner#1811, CAP-9): the agent
 * places its node empty, the answer marks every ref to it optional so the
 * panel leaves its paragraph out while the node is empty, and the check asks
 * the node to carry its input tag and its ref to stand in a paragraph of its
 * own.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@domain/provider/instance.js", () => ({
  initProvider: () => undefined,
  provider: () => ({
    availability: () => ({ upstreams: [{ upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY" }] }),
    pricingRules: (model: string) => ({ model, upstreams: [] }),
    estimate: async () => null,
    llm: {
      capabilities: async () => ({ pictures: true, contextWindow: 1_000_000 }),
      availability: () => ({ upstreams: [] }),
      judgeAvailability: () => ({ upstreams: [] }),
    },
  }),
}));

import { loadLocales } from "@breatic/core";
import { GENERATION_TEMPLATES, setLocale, t, type GenerationTemplate, type ProposalAnswer, type PromptSegment } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor } from "../propose-canvas-action.js";

import { agentShape, CAST, EDIT, loadFixtureLocales, withoutNode, type AgentShape, type Sent, type SentNode } from "./template-fixtures.js";

beforeEach(() => {
  loadLocales();
  setLocale("en");
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/**
 * A registered template by id.
 * @param id - The id.
 * @returns The template.
 */
function byId(id: string): GenerationTemplate {
  const template = GENERATION_TEMPLATES.find((one) => one.id === id);
  if (template === undefined) throw new Error(`no template ${id}`);
  return template;
}

/**
 * The product ad as the agent sends it, every input node tagged, both inputs empty.
 * @returns The proposal and where each identity sits.
 */
const productAd = (): AgentShape => agentShape(byId("product-ad-15s"), { tagInputs: true });

/**
 * Where an identity sits.
 * @param shape - The proposal.
 * @param identity - `node:<key>` or `input:<key>`.
 * @returns Its index.
 */
function indexOf(shape: AgentShape, identity: string): number {
  const at = shape.at.get(identity);
  if (at === undefined) throw new Error(`no ${identity}`);
  return at;
}

/**
 * The proposal with one node replaced.
 * @param sent - The proposal.
 * @param at - The node's index.
 * @param change - What to make of the node.
 * @returns The proposal.
 */
function withNode(sent: Sent, at: number, change: (node: SentNode) => SentNode): Sent {
  return { ...sent, nodes: sent.nodes.map((node, i) => (i === at ? change(node) : node)) };
}

/**
 * The answer, which must be placed.
 * @param answer - The answer.
 * @returns It, narrowed.
 */
function placed(answer: ProposalAnswer): Extract<ProposalAnswer, { placed: true }> {
  if (!answer.placed) throw new Error(`refused: ${answer.reason}`);
  return answer;
}

/**
 * The refs of a node's prompt, each with whether it is marked optional.
 * @param prompt - The prompt.
 * @returns Index and mark of each ref, in order.
 */
const refsOf = (prompt: readonly PromptSegment[] | undefined): Array<{ ref: number; optional: boolean }> =>
  (prompt ?? []).flatMap((segment) => (segment.ref === undefined ? [] : [{ ref: segment.ref, optional: segment.optional === true }]));

describe("an optional template input (inner#1811, CAP-9)", () => {
  it("is placed with its node empty, every ref to it in the still and the video marked optional and no other ref", () => {
    const shape = productAd();
    const answer = placed(answerFor(shape.sent));
    const person = indexOf(shape, "input:person");
    for (const key of ["still", "result"]) {
      const refs = refsOf(answer.nodes[indexOf(shape, `node:${key}`)]?.prompt);
      expect(refs.filter((one) => one.ref === person).length, key).toBeGreaterThan(0);
      for (const one of refs) expect(one.optional, `${key} ref ${String(one.ref)}`).toBe(one.ref === person);
    }
  });

  it("still refuses a proposal with no node for the required product", () => {
    const shape = withoutNode(productAd(), "input:product", t("canvas.template.product-ad-15s.input.product.note"));
    expect(answerFor(shape.sent)).toMatchObject({ placed: false, reason: expect.stringContaining('takes input "product"') });
  });

  it("refuses its node without { id, input }, which alone tells it from the product", () => {
    const shape = productAd();
    const untagged = withNode(shape.sent, indexOf(shape, "input:person"), ({ template: _tag, ...node }) => node);
    expect(answerFor(untagged)).toMatchObject({
      placed: false,
      reason: expect.stringMatching(/optional input "person".*\{ id, input \}/),
    });
  });

  it("refuses its ref in a paragraph holding another ref, and places it in a paragraph of its own", () => {
    const shape = productAd();
    const result = indexOf(shape, "node:result");
    const product = indexOf(shape, "input:product");
    const person = indexOf(shape, "input:person");
    const still = indexOf(shape, "node:still");
    /**
     * The video's prompt as its notes and the given words.
     * @param words - The words after the notes.
     * @returns The proposal.
     */
    const withWords = (words: PromptSegment[]): Sent =>
      withNode(shape.sent, result, (node) => ({ ...node, prompt: [...(node.prompt ?? []).filter((segment) => "slot" in segment && segment.slot.kind === "note"), ...words] as SentNode["prompt"] }));
    const shared = withWords([{ text: "An ad for " }, { ref: product }, { text: " held by " }, { ref: person }, { text: ".\nLit like " }, { ref: still }, { text: "." }]);
    expect(answerFor(shared)).toMatchObject({ placed: false, reason: expect.stringMatching(/optional input "person".*paragraph of its own/) });
    const apart = withWords([{ text: "An ad for " }, { ref: product }, { text: ".\nThe person looks like " }, { ref: person }, { text: ".\nLit like " }, { ref: still }, { text: "." }]);
    expect(answerFor(apart).placed).toBe(true);
  });

  it("asks of its empty node a note saying it is optional and can be left empty", () => {
    const shape = productAd();
    const result = indexOf(shape, "node:result");
    const bare = withNode(shape.sent, result, (node) => ({ ...node, prompt: (node.prompt ?? []).filter((segment) => !("slot" in segment && segment.slot.kind === "note")) }));
    expect(answerFor(bare)).toMatchObject({ placed: false, reason: expect.stringMatching(/"Person" \([^)]*optional and can be left empty\)/) });
  });

  describe("in a template whose anchor is made of shots", () => {
    beforeEach(() => {
      loadFixtureLocales();
      setLocale("en");
    });

    /**
     * The fixture as the agent sends it, every input node tagged.
     * @returns The proposal and where each identity sits.
     */
    const cast = (): AgentShape => agentShape(CAST, { tagInputs: true });

    it("marks only the refs to the optional input as optional", () => {
      const shape = cast();
      const answer = placed(answerFor(shape.sent, new Map(), [CAST]));
      const person = indexOf(shape, "input:person");
      const shots = answer.nodes[indexOf(shape, "node:clip")]?.shots ?? [];
      const refs = shots.flatMap((shot) => refsOf(shot.prompt));
      expect(refs).toContainEqual({ ref: person, optional: true });
      for (const one of refs) expect(one.optional, `ref ${String(one.ref)}`).toBe(one.ref === person);
    });

    it("refuses its ref in a shot paragraph holding another ref", () => {
      const shape = cast();
      const clip = indexOf(shape, "node:clip");
      const shared = withNode(shape.sent, clip, (node) => ({
        ...node,
        shots: (node.shots ?? []).map((shot, n) =>
          n === 1 ? { ...shot, prompt: [{ text: "Someone like " }, { ref: indexOf(shape, "input:person") }, { text: " holds " }, { ref: indexOf(shape, "input:product") }, { text: "." }] } : shot,
        ),
      }));
      expect(answerFor(shared, new Map(), [CAST])).toMatchObject({ placed: false, reason: expect.stringMatching(/optional input "person".*paragraph of its own/) });
    });
  });

  it("is called optional only in the generations whose refs to it are marked optional", () => {
    const shape = productAd();
    const person = indexOf(shape, "input:person");
    // A generation of the agent's own, outside the template, @s the empty Person with no note.
    const extra: SentNode = { role: "generate", type: "image", name: "Portrait", mode: "i2i", model: EDIT, prompt: [{ text: "A portrait of " }, { ref: person }] };
    const sent: Sent = { ...shape.sent, nodes: [...shape.sent.nodes, extra], edges: [...shape.sent.edges, { fromIndex: person, toIndex: shape.sent.nodes.length, into: "pool" }] };
    const answer = answerFor(sent);
    expect(answer).toMatchObject({ placed: false, reason: expect.stringContaining('"Portrait" needs a note') });
    expect(answer.placed ? "" : answer.reason).not.toMatch(/optional and can be left empty/);
  });

  it("is still told apart from the product when its empty node is wired in first", () => {
    const shape = productAd();
    const person = indexOf(shape, "input:person");
    const edges = [...shape.sent.edges.filter((edge) => edge.fromIndex === person), ...shape.sent.edges.filter((edge) => edge.fromIndex !== person)];
    const answer = placed(answerFor({ ...shape.sent, edges }));
    expect(answer.nodes[person]?.templateNode).toMatchObject({ template: "product-ad-15s", key: "person", input: true });
    expect(refsOf(answer.nodes[indexOf(shape, "node:result")]?.prompt).filter((one) => one.ref === person).every((one) => one.optional)).toBe(true);
  });
});
