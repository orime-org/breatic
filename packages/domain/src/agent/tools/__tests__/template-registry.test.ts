// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every generation template, applied from either entry, makes a proposal the
 * check takes (inner#1345 design 6.9, domain side): the panel's expansion goes
 * straight through the proposal check in every locale, and the proposal the
 * agent would send goes through `answerFor`. The two shapes number their
 * nodes differently; read by identity they wire, @ and guide alike.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import {
  expandTemplate,
  GENERATION_TEMPLATES,
  setLocale,
  t,
  templateSkeleton,
  type CanvasProposal,
  type GenerationTemplate,
} from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { answerFor, checkProposal } from "../propose-canvas-action.js";

import { agentShape, FIXTURE_LOCALES, FIXTURES, identityOf, loadFixtureLocales, SHEET, SOLO, STEPPED } from "./template-fixtures.js";

/** The five interface languages every template has words in. */
const LOCALES = ["en", "ja", "ko", "zh-CN", "zh-TW"];

beforeEach(() => {
  loadFixtureLocales();
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  setLocale("en");
  restoreProcessEnv();
});

/** A proposal read by identity: its edges, each generate node's refs, and its guide nodes. */
interface Structure {
  edges: string[];
  refs: Record<string, string[]>;
  guides: { name: string; prompt: unknown; anchor: string }[];
}

/**
 * A proposal read by identity.
 * @param proposal - The proposal.
 * @param identity - Index to identity, the guide nodes left out.
 * @returns Its structure.
 */
function structureOf(proposal: Pick<CanvasProposal, "nodes" | "edges">, identity: ReadonlyMap<number, string>): Structure {
  const who = (index: number): string => identity.get(index) ?? (proposal.nodes[index]?.templateNode?.key === "guide" ? "guide" : `?${String(index)}`);
  return {
    edges: proposal.edges.map((edge) => `${who(edge.fromIndex)} > ${who(edge.toIndex)} : ${edge.into ?? ""}`).sort(),
    refs: Object.fromEntries(
      proposal.nodes.flatMap((node, index) =>
        node.role === "generate"
          ? [[who(index), [...(node.prompt ?? []), ...(node.shots ?? []).flatMap((shot) => shot.prompt)].flatMap((segment) => (segment.ref === undefined ? [] : [who(segment.ref)]))]]
          : [],
      ),
    ),
    guides: proposal.nodes.flatMap((node) =>
      node.templateNode?.key === "guide" ? [{ name: node.name, prompt: node.prompt, anchor: who(node.templateNode.anchor ?? -1) }] : [],
    ),
  };
}

/**
 * The panel's expansion of a template onto an anchor at index 0, with nothing
 * on the canvas yet (design 6.9 "panel shape").
 * @param template - The template.
 * @returns The proposal, and the identity of each index but the guide's.
 */
function panelShape(template: GenerationTemplate): { proposal: CanvasProposal; identity: Map<number, string> } {
  const skeleton = templateSkeleton(template);
  const expansion = expandTemplate(template, { anchorAt: 0, base: 1, inputs: new Map(), wired: [], reuse: new Map(), guide: true });
  const anchor = expansion.rewritten.get(0);
  if (anchor === undefined) throw new Error("the expansion rewrites no anchor at 0");
  const nodes = [anchor, ...expansion.appended];
  const identity = new Map<number, string>([[0, `node:${skeleton.anchor}`]]);
  for (const [index, node] of nodes.entries()) {
    if (index === 0 || node.templateNode?.key === "guide") continue;
    if (node.templateNode !== undefined) {
      identity.set(index, `node:${node.templateNode.key}`);
      continue;
    }
    const input = skeleton.inputs.find((candidate) => t(`canvas.template.${template.id}.input.${candidate.key}.name`) === node.name);
    identity.set(index, input === undefined ? `?${node.name}` : `input:${input.key}`);
  }
  return { proposal: { nodes, edges: [...expansion.edges], rationale: "Start from the template.", groupName: "Template test" }, identity };
}

/**
 * Both shapes of one template in one locale: each passes, and they agree by identity.
 * @param template - The template.
 * @param registry - The registry the agent's proposal is judged against, or the real one.
 */
function bothShapesAgree(template: GenerationTemplate, registry?: readonly GenerationTemplate[]): void {
  const panel = panelShape(template);
  expect(checkProposal(panel.proposal)).toEqual({ ok: true });
  const agent = agentShape(template);
  const answer = answerFor(agent.sent, undefined, registry);
  expect(answer).toMatchObject({ placed: true });
  if (!answer.placed) return;
  expect(structureOf(answer, identityOf(agent.at))).toEqual(structureOf(panel.proposal, panel.identity));
}

describe("every registered template passes from both entries", () => {
  for (const template of GENERATION_TEMPLATES) {
    for (const locale of LOCALES) {
      it(`${template.id} in ${locale}: the panel's expansion passes the check, the agent's proposal is placed, and the two agree`, () => {
        setLocale(locale);
        bothShapesAgree(template);
      });
    }
  }
});

describe("the multi-node fixture passes from both entries (design 6.9)", () => {
  for (const template of [SHEET, SOLO, STEPPED]) {
    for (const locale of FIXTURE_LOCALES) {
      it(`${template.id} in ${locale}: the panel's expansion passes the check, the agent's proposal is placed, and the two agree`, () => {
        setLocale(locale);
        bothShapesAgree(template, FIXTURES);
      });
    }
  }

  it("guides the sheet fixture with its two steps from both entries", () => {
    setLocale("en");
    const panel = panelShape(SHEET);
    const guides = structureOf(panel.proposal, panel.identity).guides;
    expect(guides).toHaveLength(1);
    expect(guides[0]?.name).toBe("Fixture sheet");
    expect(guides[0]?.anchor).toBe("node:sheet");
    const words = JSON.stringify(guides[0]?.prompt);
    expect(words).toContain("Once Fixture sheet has generated, right-click it and pick Tools, then Grid split");
    expect(words).toContain("Drag the panel you like into a new node");
  });
});
