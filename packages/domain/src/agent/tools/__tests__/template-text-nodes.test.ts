// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A template's text node on the agent's side (inner#1824, CAP-3): the agent
 * reads its words as segments, sends it as a written node holding them in the
 * user's language with every blank written, and a blank left in a written
 * node wired into a generation is refused like one left in the generation's
 * own words, since the model is sent it (breatic#1361).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { describeTemplate } from "../get-generation-template.js";
import { verdictFor } from "../propose-canvas-action.js";
import { templateSegmentsText } from "../template-expansion.js";

import { agentShape, loadFixtureLocales, SCRIPTED, SUNG, TEXT_FIXTURES, type Sent, type SentNode } from "./template-fixtures.js";

beforeEach(() => {
  loadFixtureLocales();
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  restoreProcessEnv();
});

/** A blank the agent left as it is. */
const BLANK = { slot: { kind: "tweak" as const, label: "what happens first", note: "what happens first" } };

/**
 * The shape with one node's words replaced.
 * @param sent - The proposal.
 * @param at - The node's index.
 * @param prompt - Its words, or undefined for none.
 * @returns The proposal.
 */
function withWords(sent: Sent, at: number, prompt: SentNode["prompt"]): Sent {
  return { ...sent, nodes: sent.nodes.map((node, i) => (i === at ? { ...node, prompt } : node)) };
}

describe("a template text node on the agent's side (inner#1824, CAP-3)", () => {
  it("writes the text node's words out as segments, the blanks as fill-in segments, and never its locale key", () => {
    const words = templateSegmentsText(SCRIPTED, "script");
    expect(words).toContain(JSON.stringify({ text: "Who: " }));
    expect(words).toContain('"kind":"tweak"');
    expect(words).not.toContain("node.script.text");
    const said = describeTemplate(SCRIPTED);
    expect(said).toContain(`"script": ${words}`);
    expect(said).not.toContain("node.script.text");
  });

  it("lists the text node as written text going into the pools of both scenes", () => {
    const said = describeTemplate(SCRIPTED);
    expect(said).toContain('"script": written text');
    expect(said).toContain('"script" into "result" by "pool"');
    expect(said).toContain('"script" into "scene-2" by "pool"');
  });

  it("takes the template's shape with the script written in full", () => {
    expect(verdictFor(agentShape(SCRIPTED).sent, undefined, TEXT_FIXTURES)).toEqual({ ok: true });
    expect(verdictFor(agentShape(SUNG).sent, undefined, TEXT_FIXTURES)).toEqual({ ok: true });
  });

  it("refuses a text node sent with no words, giving the template's words to write from", () => {
    const shape = agentShape(SCRIPTED);
    const verdict = verdictFor(withWords(shape.sent, shape.at.get("node:script") as number, undefined), undefined, TEXT_FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-no-text" });
    expect(verdict.ok ? "" : verdict.reason).toContain(templateSegmentsText(SCRIPTED, "script"));
  });

  it("refuses a blank left in a text node wired into a generation's pool, naming the blank", () => {
    const shape = agentShape(SCRIPTED);
    const verdict = verdictFor(withWords(shape.sent, shape.at.get("node:script") as number, [{ text: "Who: a nurse\nScene 1: " }, BLANK]), undefined, TEXT_FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
    expect(verdict.ok ? "" : verdict.reason).toContain('"what happens first"');
  });

  it("refuses a blank left in a text node wired into a song's lyrics box", () => {
    const shape = agentShape(SUNG);
    const verdict = verdictFor(withWords(shape.sent, shape.at.get("node:words") as number, [{ text: "[Verse]\n" }, BLANK]), undefined, TEXT_FIXTURES);
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
  });

  it("leaves a blank in a written node whose edge into a generation is only a creative link, as its words are not sent", () => {
    // Vocal Remover takes no prompt, so an edge naming no into from words stands as a link and sends nothing.
    const verdict = verdictFor({
      nodes: [
        { role: "written", type: "text", name: "Caption", prompt: [{ text: "Made by " }, BLANK] },
        { role: "generate", type: "audio", name: "Stems", mode: "separate", model: "vocal-remover" },
      ],
      edges: [{ fromIndex: 0, toIndex: 1 }],
      rationale: "r",
      groupName: "Stems",
    });
    expect(verdict.ok ? undefined : verdict.refusal).not.toBe("template-tweak-unfilled");
  });

  it("refuses a blank in a written node the agent wired into a generation without any template", () => {
    const verdict = verdictFor({
      nodes: [
        { role: "written", type: "text", name: "Script", prompt: [{ text: "Scene 1: " }, BLANK] },
        {
          role: "generate",
          type: "video",
          name: "Scene 1",
          mode: "t2v",
          model: "seedance-2.5-text-to-video",
          params: { aspect_ratio: "9:16", duration: 15 },
          prompt: [{ text: "Play scene 1 of " }, { ref: 0 }, { text: "." }],
        },
      ],
      edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }],
      rationale: "r",
      groupName: "Episode",
    });
    expect(verdict).toMatchObject({ ok: false, refusal: "template-tweak-unfilled" });
  });
});
