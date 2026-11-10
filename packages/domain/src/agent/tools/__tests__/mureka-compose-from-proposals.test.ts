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
import type { MaterialTable } from "../propose-canvas-action.js";

import { restoreProcessEnv, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

const { answerFor, checkProposal } = await import("../propose-canvas-action.js");
const { inputSchema } = await import("../proposal-input.js");
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
function song(into: string | undefined, song: Partial<ProposalNode>, lyricsInto = "lyrics"): CanvasProposal {
  const generation: ProposalNode = { role: "generate", type: "audio", name: "Song", mode: "a2m", model: MUREKA, ...song };
  return {
    nodes: [LYRICS, TUNE, generation],
    edges: [{ fromIndex: 0, toIndex: 2, into: lyricsInto }, { fromIndex: 1, toIndex: 2, ...(into === undefined ? {} : { into }) }],
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

  it("lands as a node that takes no prompt, so the card and the canvas write none", () => {
    const answer = answerFor(inputSchema.parse(song("melody", { params: { compose_from: "melody" }, prompt: [NOTE] })));
    expect(answer.placed === false ? answer.reason : answer.nodes[2]?.takesPrompt).toBe(false);
  });

  it("counts the melody slot alone as room for empty audio", () => {
    const proposal = song("melody", { params: { compose_from: "melody" }, prompt: [NOTE, NOTE] });
    proposal.nodes.splice(2, 0, { role: "source", type: "audio", name: "Extra" });
    proposal.edges = [{ fromIndex: 0, toIndex: 3, into: "lyrics" }, { fromIndex: 1, toIndex: 3, into: "melody" }];
    const verdict = checkProposal(proposal);
    expect(verdict).toMatchObject({ ok: false, refusal: "sources-over-room" });
    expect(verdict.ok ? "" : verdict.reason).toContain("hold 1 at a time");
  });

  it("sends a recording wired with no into to the melody, the one audio place drawn", () => {
    expect(checkProposal(song(undefined, { params: { compose_from: "melody" }, prompt: [NOTE] }))).toEqual({ ok: true });
  });

  it("is refused words wired into the pool, which lives in the style box the panel does not draw", () => {
    const verdict = checkProposal(song("melody", { params: { compose_from: "melody" }, prompt: [NOTE] }, "pool"));
    expect(verdict).toMatchObject({ ok: false, refusal: "slot-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`"compose_from" is "references"`);
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

  it("lands as a node that takes its prompt", () => {
    const answer = answerFor(inputSchema.parse(song("song", { prompt: [{ text: "warm indie folk " }, NOTE] })));
    expect(answer.placed === false ? answer.reason : answer.nodes[2]?.takesPrompt).toBe(true);
  });

  it("names only song and vocals for a recording wired with no into", () => {
    const verdict = checkProposal(song(undefined, { prompt: [{ text: "warm indie folk " }, NOTE] }));
    expect(verdict).toMatchObject({ ok: false, refusal: "edge-into-ambiguous" });
    const reason = verdict.ok ? "" : verdict.reason;
    expect(reason).toContain('into: "song"');
    expect(reason).toContain('into: "vocal"');
    expect(reason).not.toContain('"melody"');
  });

  it("stands on a style, the lyrics and a song", () => {
    expect(checkProposal(song("song", { prompt: [{ text: "warm indie folk " }, NOTE] }))).toEqual({ ok: true });
  });
});

const TUNE_HELD: ProposalNode = { ...TUNE, material: "https://resource.example/audio/2026-10-08/1_tune.mp3" };
const HELD: MaterialTable = new Map([
  [TUNE_HELD.material ?? "", { kind: "audio", media: { coverUrl: null, width: null, height: null, duration: 4, mimeType: "audio/mpeg", size: 2000 } }],
]);

/**
 * A song generation wired to the lyrics, filling a slot straight from a recording.
 * @param fills - What the generation fills.
 * @param song - What else differs on the generation.
 * @param tune - The recording.
 * @returns The proposal.
 */
function filling(fills: Record<string, number[]>, song: Partial<ProposalNode>, tune = TUNE_HELD): CanvasProposal {
  return {
    nodes: [LYRICS, tune, { role: "generate", type: "audio", name: "Song", mode: "a2m", model: MUREKA, fills, ...song }],
    edges: [{ fromIndex: 0, toIndex: 2, into: "lyrics" }],
    rationale: "r",
    groupName: "Group",
  };
}

describe("a Mureka V9.5 Song proposal sending a recording somewhere the settings hide", () => {
  it("is refused a melody filled from material while composing from style and references", () => {
    const verdict = checkProposal(filling({ melody: [1] }, { prompt: [{ text: "warm indie folk" }] }), HELD);
    expect(verdict).toMatchObject({ ok: false, refusal: "slot-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`draws "melody" only while "compose_from" is "melody"`);
  });

  it("is refused a song filled from material while composing from a melody", () => {
    const verdict = checkProposal(filling({ song: [1] }, { params: { compose_from: "melody" } }), HELD);
    expect(verdict).toMatchObject({ ok: false, refusal: "slot-gated-off" });
    expect(verdict.ok ? "" : verdict.reason).toContain(`draws "song" only while "compose_from" is "references"`);
  });

  it("is told first that material reaches a slot through fills, not by an edge", () => {
    const proposal = song("melody", { prompt: [{ text: "warm indie folk" }] });
    proposal.nodes[1] = TUNE_HELD;
    expect(checkProposal(proposal, HELD)).toMatchObject({ ok: false, refusal: "edge-not-an-entry" });
  });

  it("is told first that fills takes only nodes holding material", () => {
    const verdict = checkProposal(filling({ melody: [1] }, { prompt: [{ text: "warm indie folk" }] }, TUNE));
    expect(verdict).toMatchObject({ ok: false, refusal: "fill-no-material" });
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

  it("says no condition on the prompt in Text to Music, where the setting does not exist", () => {
    const text = renderGenerationModelsForModel(modelsForMode("audio", "t2m"));
    const line = text.split("\n").find((l) => l.includes(`(${MUREKA})`)) ?? "";
    expect(line).not.toBe("");
    expect(line).not.toContain("Takes a prompt only while");
  });
});
