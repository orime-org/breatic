// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A proposal for Mureka V9.5 Song is held to the compose-from setting it
 * carries (breatic#1393), as the panel draws it: composing from a melody, the
 * style box and the song and vocal slots are not drawn; composing from style
 * and references, the melody slot is not.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadLocales } from "@breatic/core";
import type { CanvasProposal, ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

const { checkProposal } = await import("../propose-canvas-action.js");
const { renderGenerationModelsForModel } = await import("../generation-models.js");
const { modelsForMode } = await import("@domain/model-catalog/mode-catalog.js");

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

const MUREKA = "mureka-v9.5-generate-song";
const NOTE = { slot: { kind: "note" as const, label: "Put your recording in its slot first" } };
const LYRICS: ProposalNode = { role: "written", type: "text", name: "Lyrics", prompt: [{ text: "la la la" }] };
const TUNE: ProposalNode = { role: "source", type: "audio", name: "Tune" };

/**
 * A song generation wired to the lyrics and one recording.
 * @param into - The slot the recording goes into.
 * @param song - What differs on the generation.
 * @returns The proposal.
 */
function song(into: string, song: Partial<ProposalNode>): CanvasProposal {
  const generation: ProposalNode = { role: "generate", type: "audio", name: "Song", mode: "a2m", model: MUREKA, ...song };
  return {
    nodes: [LYRICS, TUNE, generation],
    edges: [{ fromIndex: 0, toIndex: 2, into: "lyrics" }, { fromIndex: 1, toIndex: 2, into }],
    rationale: "r",
    groupName: "Group",
  };
}

describe("a Mureka V9.5 Song proposal composing from a melody", () => {
  it("stands on the lyrics and the melody, with no style", () => {
    expect(checkProposal(song("melody", { params: { compose_from: "melody" }, prompt: [NOTE] }))).toEqual({ ok: true });
  });

  it("is refused a style the panel does not draw", () => {
    const verdict = checkProposal(song("melody", { params: { compose_from: "melody" }, prompt: [{ text: "lo-fi piano " }, NOTE] }));
    expect(verdict).toMatchObject({ ok: false, refusal: "prompt-box-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`"${MUREKA}" draws its prompt box only while "compose_from" is "references"`);
  });

  it("is refused a song the panel does not draw", () => {
    const verdict = checkProposal(song("song", { params: { compose_from: "melody" }, prompt: [NOTE] }));
    expect(verdict).toMatchObject({ ok: false, refusal: "slot-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`draws "song" only while "compose_from" is "references"`);
  });
});

describe("a Mureka V9.5 Song proposal composing from style and references", () => {
  it("is refused a melody the panel does not draw, the setting left at its default", () => {
    const verdict = checkProposal(song("melody", { prompt: [{ text: "warm indie folk " }, NOTE] }));
    expect(verdict).toMatchObject({ ok: false, refusal: "slot-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`draws "melody" only while "compose_from" is "melody"`);
  });

  it("stands on a style, the lyrics and a song", () => {
    expect(checkProposal(song("song", { prompt: [{ text: "warm indie folk " }, NOTE] }))).toEqual({ ok: true });
  });
});

describe("the listing of Mureka V9.5 Song in Reference to Music", () => {
  it("says which setting each slot and the prompt wait on", () => {
    const text = renderGenerationModelsForModel(modelsForMode("audio", "a2m"));
    const line = (name: string): string => text.split("\n").find((l) => l.trimStart().startsWith(`${name}:`)) ?? "";
    expect(line("melody")).toContain("it applies only while compose_from is \"melody\"");
    expect(line("song")).toContain("it applies only while compose_from is \"references\"");
    expect(text).toContain("Takes a prompt only while compose_from is \"references\".");
  });
});
