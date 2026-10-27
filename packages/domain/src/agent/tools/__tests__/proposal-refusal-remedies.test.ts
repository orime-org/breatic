// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every refusal the proposal check gives, held to what it says (design 5.10):
 * a proposal that meets it; the statements of fault, rule and fact its reason
 * makes, each checked against the catalog and the proposal; and, for a refusal
 * marked as having one fix, the proposal that follows that fix, which this
 * refusal no longer meets. The table is keyed by refusal name, so a refusal
 * added without its case does not compile (inner#1315).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { markedSegments, t, type GenerationTemplate, type ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useEnvWithKeys, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { verdictFor, type MaterialFacts, type MaterialTable } from "../propose-canvas-action.js";
import { inputSchema } from "../proposal-input.js";
import { markTypedAsWords } from "../proposal-node-checks.js";
import { REFUSALS, type RefusalId } from "../proposal-refusals.js";

import { FIXTURES, loadFixtureLocales } from "./template-fixtures.js";

beforeEach(() => {
  loadFixtureLocales();
  useFullCatalog();
});

afterAll(() => {
  loadLocales();
  restoreProcessEnv();
});

/** What the model sends, as the tool's input. */
type Sent = Parameters<typeof verdictFor>[0];

/** One refusal: what meets it, what its reason says, and its one fix where it has one. */
interface RefusalCase {
  /** The catalog the case is met under, where it is not the full one. */
  catalog?: () => void;
  /** A proposal the check refuses with this refusal. */
  meets: Sent;
  /** Statements the reason makes, each true of the catalog and the proposal. */
  states: string[];
  /** The proposal after the reason's one fix, for a refusal marked as having one. */
  fix?: Sent;
  /** Words the reason must not hold, where saying them would be untrue of this proposal. */
  absent?: string[];
  /**
   * The refusal every doubling that changes this case meets first, where none
   * can reach its own: the copies test holds each doubling to it.
   */
  noCopies?: RefusalId;
  /** The template registry the case is judged against, where it is not the real one. */
  templates?: readonly GenerationTemplate[];
}

const PIC = "https://resource.example/image/2026-10-09/1_pic.png";
const CLIP = "https://resource.example/video/2026-10-09/1_clip.mp4";
const ELSEWHERE = "https://elsewhere.example/a.png";
const MISSING = "https://resource.example/image/2026-10-09/1_typo.png";
const TUNES = ["1_a", "2_x", "3_c"].map((name) => `https://resource.example/audio/2026-10-09/${name}.mp3`);

const MEDIA = { coverUrl: null, width: 640, height: 480, duration: 3, mimeType: "image/png", size: 100 };
const MATERIALS: MaterialTable = new Map<string, MaterialFacts | "missing">([
  [PIC, { kind: "image", media: MEDIA }],
  [CLIP, { kind: "video", media: { ...MEDIA, mimeType: "video/mp4" } }],
  ...TUNES.map((tune): [string, MaterialFacts] => [tune, { kind: "audio", media: { ...MEDIA, mimeType: "audio/mpeg" } }]),
  [MISSING, "missing"],
]);

const T2I = "nano-banana-2";
const EDIT = "nano-banana-pro-edit-ultra";
const ANGLES = "qwen-image-edit-multiple-angles";
const HEAD = "omnihuman-1.5";
const SCORE = "sonilo-video-to-music";
const SONG = "mureka-v9.5-generate-song";
const TTS = "realtime-tts-2";
const SHOTS = "kling-v3.0-4k-text-to-video";
const VID = "minimax-h3-image-to-video";
const OMNI_SHOTS = "gemini-omni-1.1-flash-image-to-video";

/** A note, as every to-do on a card is. */
const NOTE = { slot: { kind: "note" as const, label: "Put the picture in Pic first" } };

/**
 * A group of nodes and edges, named.
 * @param nodes - The nodes.
 * @param edges - The edges.
 * @returns What the model sends.
 */
function group(nodes: Sent["nodes"], edges: Sent["edges"] = []): Sent {
  return { nodes, edges, rationale: "r", groupName: "Group" };
}

/**
 * A generation node.
 * @param type - Its kind.
 * @param mode - Its mode.
 * @param model - Its model.
 * @param rest - Everything else on it.
 * @returns The node.
 */
function gen(type: ProposalNode["type"], mode: string, model: string, rest: Partial<Sent["nodes"][number]> = {}): Sent["nodes"][number] {
  return { role: "generate", type, name: "Gen", mode, model, prompt: [{ text: "Make it." }], ...rest };
}

/** A text-to-image generation standing on its own. */
const DRAW = gen("image", "t2i", T2I);
/** An empty picture node. */
const EMPTY_PIC: Sent["nodes"][number] = { role: "source", type: "image", name: "Pic" };
/** A picture node holding material. */
const HELD_PIC: Sent["nodes"][number] = { role: "source", type: "image", name: "Pic", material: PIC };
/** Words kept as written. */
const WORDS: Sent["nodes"][number] = { role: "written", type: "text", name: "Words", prompt: [{ text: "A line of copy." }] };
/** An image edit with the empty picture in its pool, @'d and noted. */
const EDIT_POOL = gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] });
/** An image edit with the empty picture at index 1 in its pool, @'d and noted. */
const EDIT_POOL_1 = gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 1 }, NOTE] });
/** Two shots that add up to the default five seconds. */
const TWO_SHOTS = [
  { prompt: [{ text: "A paper boat." }], duration: 2 },
  { prompt: [{ text: "The pond at dusk." }], duration: 3 },
];
/** A multi-shot video. */
const STORY = gen("video", "multi_shot", SHOTS, { prompt: undefined, params: { duration: 5 }, shots: TWO_SHOTS });

/** Words longer than one shot of the multi-shot model holds. */
const LONG_SCRIPT = "x".repeat(600);

/** An empty clip node. */
const CLIP_EMPTY: Sent["nodes"][number] = { role: "source", type: "video", name: "Clip" };
/** A clip node holding material. */
const CLIP_HELD: Sent["nodes"][number] = { role: "source", type: "video", name: "Clip", material: CLIP };
/**
 * The storyboard template's words, each reference mark sent as a ref to node
 * 0.
 * @returns The segments.
 */
function storyboardSegments(): NonNullable<Sent["nodes"][number]["prompt"]> {
  return markedSegments(t("canvas.template.storyboard-grid-25.prompt")).map((segment) => {
    if (segment.slot === undefined) return { text: segment.text ?? "" };
    return segment.slot.kind === "asset" ? { ref: 0 } : segment.slot.kind === "tweak" ? { slot: { kind: "tweak", label: segment.slot.label, note: segment.slot.note } } : { slot: { kind: "note", label: segment.slot.label } };
  });
}

/**
 * Empty picture nodes, numbered.
 * @param count - How many.
 * @returns The nodes.
 */
function PICS(count: number): Sent["nodes"] {
  return Array.from({ length: count }, (_, i) => ({ ...EMPTY_PIC, name: `Pic ${String(i)}` }));
}

/**
 * Refs to the first nodes.
 * @param count - How many.
 * @returns The segments.
 */
function REFS(count: number): { ref: number }[] {
  return Array.from({ length: count }, (_, i) => ({ ref: i }));
}

/**
 * Notes, one per node.
 * @param count - How many.
 * @returns The segments.
 */
function NOTES(count: number): (typeof NOTE)[] {
  return Array.from({ length: count }, () => NOTE);
}

/** The values the multiple-angles model has a control for. */
const ANGLES_SETTABLE = ["distance", "horizontal_angle", "vertical_angle"];

/** A note to generate a node first. */
const GEN_FIRST = { slot: { kind: "note" as const, label: "Generate Still first" } };
/** The one-node fixture's anchor, its empty reference at index 0 @'d and noted. */
const SOLO_ANCHOR: Sent["nodes"][number] = { role: "generate", type: "image", name: "Gen", template: { id: "fixture-solo" }, prompt: [{ text: "Redraw " }, { ref: 0 }, NOTE] };
/** The multi-shot fixture's generated still, under its key. */
const STILL: Sent["nodes"][number] = { role: "generate", type: "image", name: "Still", template: { id: "fixture-shots", key: "still" }, prompt: [{ text: "A woman in a yellow coat." }] };
/** The multi-shot fixture's anchor, with one shot naming nothing. */
const CLIP_ANCHOR: Sent["nodes"][number] = { role: "generate", type: "video", name: "Clip", template: { id: "fixture-shots" }, shots: [{ prompt: [{ text: "She walks along the shore." }], duration: 5 }] };
/** The note the fixture sheet's anchor carries for its generated sketch, picked into a slot. */
const SKETCH_FIRST = { slot: { kind: "note" as const, label: "Generate Sketch first, then pick it into the style slot" } };
/**
 * A note to put material in a node first.
 * @param name - The node's name.
 * @returns The note segment.
 */
function putFirst(name: string): { slot: { kind: "note"; label: string } } {
  return { slot: { kind: "note", label: `Put the picture in ${name} first` } };
}
/**
 * The multi-node fixture as the agent sends it, every edge but the one from
 * the sketch into the sheet's style slot: 0 the anchor, 1 the sketch, 2 the
 * palette resource, 3 to 6 the inputs pose, front, back and character.
 */
const SHEET_NODES: Sent["nodes"] = [
  { role: "generate", type: "image", name: "Sheet", template: { id: "fixture-sheet" }, prompt: [putFirst("Front"), putFirst("Back"), putFirst("Character"), { text: "Draw " }, { ref: 4 }, { text: " and " }, { ref: 5 }, { text: " of " }, { ref: 6 }, { text: "." }] },
  { role: "generate", type: "image", name: "Sketch", template: { id: "fixture-sheet", key: "sketch" }, prompt: [putFirst("Pose"), putFirst("Character"), { text: "A sketch of " }, { ref: 6 }, { text: " posed as " }, { ref: 3 }, { text: " in the colours of " }, { ref: 2 }, { text: "." }] },
  { role: "source", type: "image", name: "Palette", template: { id: "fixture-sheet", key: "palette" } },
  { role: "source", type: "image", name: "Pose" },
  { role: "source", type: "image", name: "Front" },
  { role: "source", type: "image", name: "Back" },
  { role: "source", type: "image", name: "Character" },
];
/** The fixture sheet's edges, all but the sketch's into the sheet. */
const SHEET_EDGES: Sent["edges"] = [
  { fromIndex: 2, toIndex: 1, into: "pool" },
  { fromIndex: 3, toIndex: 1, into: "pool" },
  { fromIndex: 4, toIndex: 0, into: "pool" },
  { fromIndex: 5, toIndex: 0, into: "pool" },
  { fromIndex: 6, toIndex: 1, into: "pool" },
  { fromIndex: 6, toIndex: 0, into: "pool" },
];

// The template's words are read from the locales while the cases are built.
loadLocales();

const CASES: Record<RefusalId, RefusalCase[]> = {
  "nothing-generates": [{
    meets: { nodes: [EMPTY_PIC], edges: [], rationale: "r" },
    states: ["Nothing here generates, so a card placed from this leaves the reader nothing to press."],
  }],
  "nothing-generates-words": [{
    meets: { nodes: [WORDS], edges: [], rationale: "r" },
    states: ["words with nothing generating belong in your reply"],
  }],
  "edge-outside": [{
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 4 }]),
    states: ['An edge runs from node 0 ("Gen") to node 4 (not in the group) (no into).', 'Take every edge from node 0 ("Gen") to node 4 (not in the group) off.'],
    fix: group([DRAW]),
  }, {
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 4 }, { fromIndex: 0, toIndex: 4, into: "pool" }]),
    states: ['2 edges run from node 0 ("Gen") to node 4 (not in the group) (no into, into "pool").', 'Take every edge from node 0 ("Gen") to node 4 (not in the group) off.'],
    fix: group([DRAW]),
  }],
  "edge-self-loop": [{
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 0 }]),
    states: ['An edge runs from node 0 ("Gen") to itself (no into).', 'Take every edge from node 0 ("Gen") to itself off.'],
    fix: group([DRAW]),
  }, {
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 0 }, { fromIndex: 0, toIndex: 0 }]),
    states: ['2 edges run from node 0 ("Gen") to itself (no into, no into).', 'Take every edge from node 0 ("Gen") to itself off.'],
    fix: group([DRAW]),
  }],
  "edge-repeated": [{
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['2 edges run from node 0 ("Pic") to node 1 ("Gen") (into "pool", into "pool"), and the canvas holds one edge between two nodes.'],
    absent: ["one way"],
  }, {
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1 }]),
    states: ['3 edges run from node 0 ("Pic") to node 1 ("Gen") (into "pool", into "pool", no into)'],
  }, {
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1, into: "style_images" }]),
    states: ['(into "pool", into "style_images")'],
  }],
  "edge-into-nothing-generating": [{
    meets: group([DRAW, WORDS], [{ fromIndex: 0, toIndex: 1 }]),
    states: ['An edge flows into "Words", which generates nothing'],
  }],
  "edge-not-allowed": [{
    meets: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })], [{ fromIndex: 0, toIndex: 1 }]),
    states: ["The canvas does not let a video node feed an audio node", 'An edge runs from node 0 ("Clip") to node 1 ("Gen") (no into).', 'Take every edge from node 0 ("Clip") to node 1 ("Gen") off.', '"Clip" goes into "Gen" unwired, with a note saying to pick it into "video" and no ref.'],
    fix: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })]),
  }, {
    meets: group([CLIP_EMPTY, gen("image", "i2i", EDIT)], [{ fromIndex: 0, toIndex: 1 }]),
    states: ['Take every edge from node 0 ("Clip") to node 1 ("Gen") off.', '"nano-banana-pro-edit-ultra" takes no video node, so "Clip" has no way into "Gen".'],
    fix: group([CLIP_EMPTY, gen("image", "i2i", EDIT)]),
  }, {
    // The generation names no model the catalog serves: the canvas rule is all there is to say.
    meets: group([CLIP_EMPTY, gen("image", "i2i", "no-such-model")], [{ fromIndex: 0, toIndex: 1 }]),
    states: ['The canvas does not let a video node feed an image node, by your hand or theirs. An edge runs from node 0 ("Clip") to node 1 ("Gen") (no into). Take every edge from node 0 ("Clip") to node 1 ("Gen") off.'],
    fix: group([CLIP_EMPTY, gen("image", "i2i", "no-such-model")]),
  }, {
    // The same edge twice: the fix names the pair, so following it takes both.
    meets: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })], [{ fromIndex: 0, toIndex: 1 }, { fromIndex: 0, toIndex: 1, into: "video" }]),
    states: ['2 edges run from node 0 ("Clip") to node 1 ("Gen") (no into, into "video")', 'Take every edge from node 0 ("Clip") to node 1 ("Gen") off.'],
    fix: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })]),
  }, {
    // Two nodes share a name: the fix names the pair by index, so the image's pool edge stays.
    meets: group([CLIP_EMPTY, { ...EMPTY_PIC, name: "Clip" }, EDIT_POOL_1], [{ fromIndex: 0, toIndex: 2 }, { fromIndex: 1, toIndex: 2, into: "pool" }]),
    states: ['An edge runs from node 0 ("Clip") to node 2 ("Gen") (no into).', 'Take every edge from node 0 ("Clip") to node 2 ("Gen") off.'],
    fix: group([CLIP_EMPTY, { ...EMPTY_PIC, name: "Clip" }, EDIT_POOL_1], [{ fromIndex: 1, toIndex: 2, into: "pool" }]),
  }],
  "edge-ring": [{
    meets: group(
      [gen("image", "i2i", EDIT, { name: "A", prompt: [{ text: "From " }, { ref: 1 }, NOTE] }), gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "From " }, { ref: 0 }, NOTE] })],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 1, toIndex: 0, into: "pool" }],
    ),
    states: ["Those edges make a ring"],
  }],
  "group-unnamed": [{
    meets: { nodes: [EMPTY_PIC, EDIT_POOL], edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }], rationale: "r" },
    states: ["Two or more nodes land together in a group, and it has no name.", "Give the group a name saying what it is for."],
    fix: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "template-unknown": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, template: { id: "no-such-template" }, mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['No template "no-such-template". Templates: storyboard-grid-25'],
  }, {
    meets: group([EMPTY_PIC, { ...EDIT_POOL, template: { id: "no-such-template" }, mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['No template "no-such-template". Templates: fixture-sheet, fixture-solo, fixture-steps, fixture-shots.'],
    templates: FIXTURES,
  }],
  // Design 6.7 step 2: the key and input checks below replace "template-role" and "template-type".
  "template-key-unknown": [{
    meets: group([EMPTY_PIC, { ...SOLO_ANCHOR, template: { id: "fixture-solo", key: "nope" } }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"nope"', '"fixture-solo"', '"edit"'],
    templates: FIXTURES,
  }, {
    meets: group([{ ...EMPTY_PIC, template: { id: "fixture-solo", input: "nope" } }, SOLO_ANCHOR], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"nope"', '"fixture-solo"', '"reference"'],
    templates: FIXTURES,
  }],
  "template-key-kind": [{
    // A generate key on a source node.
    meets: group([{ ...EMPTY_PIC, template: { id: "fixture-shots", key: "still" } }, DRAW]),
    states: ['"still"', "generate", "source"],
    templates: FIXTURES,
  }, {
    // An image key on a video node.
    meets: group([gen("video", "t2v", SHOTS, { template: { id: "fixture-shots", key: "still" } })]),
    states: ['"still"', "image", "video"],
    templates: FIXTURES,
  }, {
    // An image input tagged on a video node.
    meets: group([{ ...CLIP_EMPTY, template: { id: "fixture-solo", input: "reference" } }, { ...SOLO_ANCHOR, prompt: [{ text: "Make it." }] }]),
    states: ['"reference"', "image", "video"],
    templates: FIXTURES,
  }],
  "template-key-missing": [{
    meets: group([CLIP_ANCHOR]),
    states: ['"still"', '"fixture-shots"'],
    templates: FIXTURES,
  }, {
    // Two candidates, neither wired in: the reason lists both.
    meets: group([STILL, { ...STILL, name: "Still 2" }, CLIP_ANCHOR]),
    states: ['"still"', 'node 0 ("Still")', 'node 1 ("Still 2")'],
    templates: FIXTURES,
  }],
  "template-key-repeated": [{
    meets: group(
      [STILL, { ...STILL, name: "Still 2" }, { ...CLIP_ANCHOR, shots: [{ prompt: [GEN_FIRST, GEN_FIRST, { ref: 0 }, { text: " meets " }, { ref: 1 }, { text: "." }], duration: 5 }] }],
      [{ fromIndex: 0, toIndex: 2, into: "pool" }, { fromIndex: 1, toIndex: 2, into: "pool" }],
    ),
    states: ['"still"', 'node 0 ("Still")', 'node 1 ("Still 2")'],
    templates: FIXTURES,
  }],
  "template-edge-missing": [{
    // The missing template edge goes into a slot param.
    meets: group(SHEET_NODES, SHEET_EDGES),
    states: ['node 1 ("Sketch")', 'node 0 ("Sheet")', '"style_images"', "a note saying to pick it there"],
    fix: group([{ ...(SHEET_NODES[0] as Sent["nodes"][number]), prompt: [SKETCH_FIRST, ...(SHEET_NODES[0]?.prompt ?? [])] }, ...SHEET_NODES.slice(1)], [...SHEET_EDGES, { fromIndex: 1, toIndex: 0, into: "style_images" }]),
    templates: FIXTURES,
  }, {
    // The node the edge goes into runs multi_shot: the ref and note go in a shot.
    meets: group([STILL, CLIP_ANCHOR]),
    states: ['node 0 ("Still")', 'node 1 ("Clip")', '"pool"', "its ref and note in a shot"],
    fix: group([STILL, { ...CLIP_ANCHOR, shots: [{ prompt: [GEN_FIRST, { ref: 0 }, { text: " walks along the shore." }], duration: 5 }] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    templates: FIXTURES,
  }],
  "template-resource-material": [{
    // A template's resource lands holding the template's own file.
    meets: group([{ ...HELD_PIC, template: { id: "fixture-sheet", key: "palette" } }, gen("image", "i2i", EDIT, { prompt: [{ text: "Make it with " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Pic"', '"fixture-sheet"', '"palette"', "takes no material"],
    templates: FIXTURES,
  }],
  "template-edge-into": [{
    // The sketch goes into the sheet's style slot, and the edge says the pool.
    meets: group(
      [{ ...(SHEET_NODES[0] as Sent["nodes"][number]), prompt: [SKETCH_FIRST, ...(SHEET_NODES[0]?.prompt ?? [])] }, ...SHEET_NODES.slice(1)],
      [...SHEET_EDGES, { fromIndex: 1, toIndex: 0, into: "pool" }],
    ),
    states: ['node 1 ("Sketch")', '"style_images"', '"pool"', 'change the edge from node 1 ("Sketch") so it goes into it'],
    fix: group(
      [{ ...(SHEET_NODES[0] as Sent["nodes"][number]), prompt: [SKETCH_FIRST, ...(SHEET_NODES[0]?.prompt ?? [])] }, ...SHEET_NODES.slice(1)],
      [...SHEET_EDGES, { fromIndex: 1, toIndex: 0, into: "style_images" }],
    ),
    templates: FIXTURES,
  }, {
    // Sent into the pool and @'d there: the slot takes a note and no ref.
    meets: group(
      [{ ...(SHEET_NODES[0] as Sent["nodes"][number]), prompt: [...(SHEET_NODES[0]?.prompt ?? []), { text: " in the style of " }, { ref: 1 }] }, ...SHEET_NODES.slice(1)],
      [...SHEET_EDGES, { fromIndex: 1, toIndex: 0, into: "pool" }],
    ),
    states: ['node 1 ("Sketch")', '"style_images"', "a note saying to pick it there and no ref", 'change the edge from node 1 ("Sketch")'],
    absent: ["send node 1"],
    fix: group(
      [{ ...(SHEET_NODES[0] as Sent["nodes"][number]), prompt: [SKETCH_FIRST, ...(SHEET_NODES[0]?.prompt ?? []), { text: " in the style of Sketch" }] }, ...SHEET_NODES.slice(1)],
      [...SHEET_EDGES, { fromIndex: 1, toIndex: 0, into: "style_images" }],
    ),
    templates: FIXTURES,
  }],
  "template-input-missing": [{
    meets: group([{ ...SOLO_ANCHOR, prompt: [{ text: "Make it a watercolour." }] }]),
    states: ['"reference"', '"fixture-solo"'],
    templates: FIXTURES,
  }],
  "template-no-prompt": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, prompt: undefined, template: { id: "storyboard-grid-25" }, mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Gen" names template "storyboard-grid-25" and sends no prompt.', 'On node 1 ("Gen"), write a prompt.', "The template's prompt, to rewrite in the reader's language with their story or detail in it:", 'an empty one by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first'],
    fix: group([EMPTY_PIC, { ...EDIT_POOL, template: { id: "storyboard-grid-25" }, mode: undefined, model: undefined, prompt: [...storyboardSegments(), NOTE] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }, {
    // The node settles its own model, which takes no picture: the pool the template's own model has is not its.
    meets: group([{ ...DRAW, prompt: undefined, template: { id: "storyboard-grid-25" } }]),
    states: ['"Gen" names template "storyboard-grid-25" and sends no prompt.', 'On node 0 ("Gen"), write a prompt.'],
    absent: ['into: "pool"', "goes into the pool"],
    fix: group([{ ...DRAW, template: { id: "storyboard-grid-25" } }]),
  }, {
    // A multi_shot generate node naming a template and sending no shots.
    meets: group([STILL, { ...CLIP_ANCHOR, shots: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Clip" names template "fixture-shots" and sends no prompt.', 'On node 1 ("Clip"), write a prompt.'],
    fix: group([STILL, { ...CLIP_ANCHOR, shots: [{ prompt: [GEN_FIRST, { ref: 0 }, { text: " walks along the shore." }], duration: 5 }] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    templates: FIXTURES,
  }],
  "sources-no-taker": [{
    meets: group([EMPTY_PIC, DRAW]),
    states: ["This group places 1 image source node(s), and nothing in it takes image material."],
  }],
  "sources-over-room": [{
    meets: group([EMPTY_PIC, { ...EMPTY_PIC, name: "Pic 2" }, gen("video", "talking_head", HEAD, { prompt: [NOTE, NOTE] })]),
    states: ["This group places 2 image source node(s), and the panels in it hold 1 at a time."],
  }],
  "material-unused": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Make it." }] })]),
    states: ['"Pic" holds material that nothing here uses, and material reaches a generation only through fills or an edge into its pool.', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it, or through fills "style_images" on "Gen", with no edge and no ref.'],
  }, {
    meets: group([{ ...DRAW, name: "Draw" }, gen("video", "i2v", VID, { name: "Vid", prompt: [{ text: "Move it." }, NOTE] }), { ...HELD_PIC, name: "B" }], [{ fromIndex: 0, toIndex: 1, into: "image" }]),
    states: ['"nano-banana-2" takes no image node, so "B" has no way into "Draw".', '"B" goes into "Vid" through fills "image" on "Vid", with no edge and no ref.'],
  }],
  "loose-without-note": [{
    meets: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: undefined })]),
    states: ['"Pic" goes into no generation, so the reader picks it into a slot in the panel, and a note tells them which.', "carry 0 note(s) beyond those their wired nodes use"],
  }],
  "text-generates": [{
    meets: group([{ role: "generate", type: "text", name: "Copy", prompt: [{ text: "Write it." }] }, DRAW]),
    states: ['"Copy" is a text node, and nothing is generated into one; words go on a written node.'],
  }],
  "no-mode-model": [{
    meets: group([gen("image", "t2i", T2I, { mode: undefined })]),
    states: ["it needs a mode and a model"],
  }],
  "mode-unbacked": [{
    meets: group([gen("image", "no-such-mode", T2I)]),
    states: ['No model here backs "no-such-mode" on an image node. It offers: t2i'],
  }],
  "no-model-for-kind": [{
    catalog: () => useEnvWithKeys([]),
    meets: group([gen("video", "t2v", SHOTS)]),
    states: ["No video model can generate right now."],
  }],
  "model-not-in-mode": [{
    meets: group([gen("image", "t2i", EDIT)]),
    states: [`"${EDIT}" does not back "t2i". Those that do:`],
  }],
  "shots-outside-multishot": [{
    meets: group([gen("video", "t2v", SHOTS, { prompt: undefined, shots: TWO_SHOTS })]),
    states: ['Shots belong to the multi_shot mode, and "Gen" runs "t2v". On node 0 ("Gen"), leave shots out.'],
    fix: group([gen("video", "t2v", SHOTS, { prompt: undefined })]),
  }],
  "multishot-no-shots": [{
    meets: group([gen("video", "multi_shot", SHOTS, { params: { duration: 5 } })]),
    states: ["In the multi_shot mode the shots are what is generated. On node 0 (\"Gen\"), give shots"],
    fix: group([{ ...gen("video", "multi_shot", SHOTS, { params: { duration: 5 } }), shots: TWO_SHOTS }]),
  }],
  "shots-with-prompt": [{
    meets: group([{ ...STORY, prompt: [{ text: "Make it." }] }]),
    states: ["With shots the main prompt is not sent; its words, refs and notes go in the shots. On node 0 (\"Gen\"), leave prompt out."],
    fix: group([STORY]),
  }],
  "no-prompt-box": [{
    meets: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [{ text: "Talk." }, NOTE] })]),
    states: [`"${HEAD}" draws no prompt box`, 'On node 1 ("Gen"), keep only notes'],
    fix: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [NOTE] })]),
  }],
  "ref-outside": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 7 }] })]),
    states: ['A ref in "Gen" points outside the group: {"ref": 7}. On node 0 ("Gen"), take every {"ref": 7} out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
  }, {
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 7 }, { ref: 7 }] })]),
    states: ['A ref in "Gen" points outside the group: {"ref": 7}, 2 times.', 'On node 0 ("Gen"), take every {"ref": 7} out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
  }],
  "ref-self": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 0 }] })]),
    states: ['"Gen" @s itself with {"ref": 0}, and a node cannot @ itself. On node 0 ("Gen"), take every {"ref": 0} out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
  }, {
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 0 }, { ref: 0 }] })]),
    states: ['"Gen" @s itself with {"ref": 0}, 2 times, and a node cannot @ itself.', 'On node 0 ("Gen"), take every {"ref": 0} out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
  }, {
    // Another generation @s the same index, rightly: the fix acts on the named node only.
    meets: group([gen("image", "t2i", T2I, { name: "A", prompt: [{ text: "Make " }, { ref: 0 }] }), gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['On node 0 ("A"), take every {"ref": 0} out.'],
    fix: group([gen("image", "t2i", T2I, { name: "A", prompt: [{ text: "Make " }] }), gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "ref-arrives-otherwise": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] }, prompt: [{ text: "In the style of " }, { ref: 0 }] })]),
    states: ['"Pic" goes into "Gen" through fills "style_images" on "Gen", with no edge and no ref, and only a node wired into the pool takes a ref.'],
  }, {
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Style of " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]),
    states: ['"Pic" goes into "Gen" by an edge with into: "style_images" and a note saying to pick it there and no ref, and only a node wired into the pool takes a ref.'],
  }, {
    meets: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop for " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
    states: ['"Words" goes into "Gen" by an edge with into: "lyrics", which landing @s into that box, and no ref, and only a node wired into the pool takes a ref.'],
  }],
  "ref-not-pooled": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })]),
    states: ['"Pic" is @\'d by a ref in "Gen" but is not wired into its pool, and only a node in its pool takes a ref.', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.', 'The pool of "Gen" takes 11 image node(s) and holds none.'],
  }, {
    meets: group(PICS(4).concat([gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, ...REFS(4), ...NOTES(4)] })]), [0, 1, 2].map((i) => ({ fromIndex: i, toIndex: 4, into: "pool" }))),
    states: ['"Pic 3" is @\'d by a ref in "Gen" but is not wired into its pool', 'The pool of "Gen" takes 3 image node(s) and holds "Pic 0", "Pic 1", "Pic 2".'],
  }, {
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }, { text: " like " }, { ref: 0 }, NOTE] })]),
    states: ['"Pic" is @\'d by 2 refs in "Gen" but is not wired into its pool'],
  }],
  "ref-not-pooled-no-pool": [{
    meets: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, { ref: 0 }, NOTE] })]),
    states: ['"nano-banana-2" has no pool for an image node.', 'On node 1 ("Gen"), take every {"ref": 0} out.', '"nano-banana-2" takes no image node, so "Pic" has no way into "Gen".'],
    fix: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, NOTE] })]),
  }, {
    meets: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score " }, { ref: 0 }] })]),
    states: ['On node 1 ("Gen"), take every {"ref": 0} out.', '"Clip" goes into "Gen" through fills "video" on "Gen", with no edge and no ref.'],
    fix: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score " }] })]),
  }, {
    meets: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, { ref: 0 }, { text: " like " }, { ref: 0 }, NOTE] })]),
    states: ['"Pic" is @\'d by 2 refs in "Gen"', 'On node 1 ("Gen"), take every {"ref": 0} out.'],
    fix: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, { text: " like " }, NOTE] })]),
  }, {
    // A second generation with a pool @s the same index, rightly: the fix acts on the named node only.
    meets: group([EMPTY_PIC, gen("image", "t2i", T2I, { name: "G1", prompt: [{ text: "Draw " }, { ref: 0 }, NOTE] }), gen("image", "i2i", EDIT, { name: "G2", prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 2, into: "pool" }]),
    states: ['On node 1 ("G1"), take every {"ref": 0} out.'],
    fix: group([EMPTY_PIC, gen("image", "t2i", T2I, { name: "G1", prompt: [{ text: "Draw " }, NOTE] }), gen("image", "i2i", EDIT, { name: "G2", prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 2, into: "pool" }]),
  }],
  "way-over-room": [{
    meets: group(PICS(4).concat([gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, ...REFS(4), ...NOTES(4)] })]), [0, 1, 2, 3].map((i) => ({ fromIndex: i, toIndex: 4, into: "pool" }))),
    states: [`"${ANGLES}" takes 3 image node(s) by "pool", and 4 are going that way ("Pic 0", "Pic 1", "Pic 2", "Pic 3").`, 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first.'],
  }, {
    // Over the pool with another way open: the other way is said as a rule, with its room and who holds it.
    meets: group(PICS(12).concat([gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(12), ...NOTES(12)] })]), Array.from({ length: 12 }, (_, i) => ({ fromIndex: i, toIndex: 12, into: "pool" }))),
    states: [`"${EDIT}" takes 11 image node(s) by "pool", and 12 are going that way`, 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.', '"style_images" takes 3 image node(s) and holds none.'],
  }, {
    // Nodes holding material and empty ones over the same way: the ways are said for each.
    meets: group(
      [...PICS(11), { ...HELD_PIC, name: "M" }, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(12), ...NOTES(11)] })],
      Array.from({ length: 12 }, (_, i) => ({ fromIndex: i, toIndex: 12, into: "pool" })),
    ),
    states: ['An image node holding material goes into "Gen" by an edge with into: "pool" and a ref @\'ing it, or through fills "style_images" on "Gen", with no edge and no ref.', 'An empty image node goes into "Gen"'],
  }, {
    meets: group(
      [...["A", "X", "C"].map((name, i): Sent["nodes"][number] => ({ role: "source", type: "audio", name, material: TUNES[i] })), WORDS, gen("audio", "a2m", SONG, { prompt: [{ text: "Make a song." }], fills: { melody: [0, 1, 2], vocal: [1] } })],
      [{ fromIndex: 3, toIndex: 4, into: "lyrics" }],
    ),
    states: ['by "melody", and 3 are going that way ("A", "X", "C")', '"vocal" takes 1 audio node(s) and holds "X".'],
  }],
  "ref-missing": [{
    meets: group([WORDS, { ...STORY }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Words" is wired into the pool of "Gen" and no ref @s it. A node in the pool is used only where a ref @s it in the shot: {"ref": 0}.'],
  }],
  "notes-missing": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Gen" needs a note for each of "Pic"', "and carries 0", 'On node 1 ("Gen"), give each one a note in the prompt'],
    fix: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }, {
    // With shots, notes go in a shot.
    meets: group([EMPTY_PIC, gen("video", "multi_shot", OMNI_SHOTS, { prompt: undefined, params: { duration: 5 }, shots: TWO_SHOTS })], [{ fromIndex: 0, toIndex: 1, into: "image" }]),
    states: ['On node 1 ("Gen"), give each one a note in the shot'],
    noCopies: "edge-repeated",
    fix: group([EMPTY_PIC, gen("video", "multi_shot", OMNI_SHOTS, { prompt: undefined, params: { duration: 5 }, shots: [{ ...TWO_SHOTS[0] as (typeof TWO_SHOTS)[number], prompt: [{ text: "A paper boat." }, NOTE] }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] })], [{ fromIndex: 0, toIndex: 1, into: "image" }]),
  }],
  "shot-empty": [{
    meets: group([{ ...STORY, shots: [{ prompt: [], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    states: ["Shot 1 writes nothing. Every shot needs its own words."],
  }],
  "too-many-shots": [{
    // The seconds do not add up either: the reason says nothing about them.
    meets: group([{ ...STORY, params: { duration: 5 }, shots: Array.from({ length: 7 }, (_, i) => ({ prompt: [{ text: `Shot ${String(i)}.` }], duration: 3 })) }]),
    states: [`"${SHOTS}" takes at most 6 shots, and this proposal gives 7.`],
    absent: ["seconds"],
  }],
  "shot-too-long": [{
    meets: group([{ ...STORY, shots: [{ prompt: [{ text: LONG_SCRIPT }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    states: [`Shot 1 is 600 characters, longer than the 512 characters "${SHOTS}" takes for one shot.`],
  }],
  "shots-duration": [{
    meets: group([{ ...STORY, params: { duration: 8 } }]),
    states: ["The shots add up to 5 seconds and duration is 8."],
  }],
  "prompt-missing": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [] })]),
    states: [`"${T2I}" generates from what the prompt says, and this proposal writes nothing in it. On node 0 ("Gen"), write a prompt.`],
    fix: group([DRAW]),
  }],
  "lyrics-missing": [{
    meets: group([gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })]),
    states: ['A written text node goes into "Gen" by an edge with into: "lyrics"'],
  }],
  "prompt-too-long": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "y".repeat(2100) }] })]),
    states: [`"${TTS}" takes`, "and this prompt is 2100."],
  }],
  "script-too-long-for-shot": [{
    meets: group([{ ...WORDS, prompt: [{ text: LONG_SCRIPT }] }, { ...STORY, shots: [{ prompt: [{ ref: 0 }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['so @\'ing it into a shot is refused at Generate.'],
  }],
  "written-takes-no-mark": [{
    meets: group([{ ...WORDS, prompt: [{ text: "Copy " }, NOTE] }, DRAW]),
    states: ['"Words" holds words the reader keeps as they are, so it takes no ref or note; it carries the note "Put the picture in Pic first".', 'On node 0 ("Words"), take out every ref and note it carries, the typed ones included, and say what you meant in your own message.'],
    fix: group([{ ...WORDS, prompt: [{ text: "Copy " }] }, DRAW]),
  }, {
    meets: group([{ ...WORDS, prompt: [{ text: "Copy " }, NOTE, { text: " and " }, NOTE] }, DRAW]),
    states: ['it carries the note "Put the picture in Pic first", the note "Put the picture in Pic first".'],
    fix: group([{ ...WORDS, prompt: [{ text: "Copy " }, { text: " and " }] }, DRAW]),
  }, {
    // A note segment and a note typed as words are named together.
    meets: group([{ ...WORDS, prompt: [{ text: "Copy (💡 do this) " }, NOTE] }, DRAW]),
    states: ['it carries the note "Put the picture in Pic first", the typed "(💡 do this)".'],
    fix: group([{ ...WORDS, prompt: [{ text: "Copy  " }] }, DRAW]),
  }, {
    // A mark typed across two text segments is read as one.
    meets: group([{ ...WORDS, prompt: [{ text: "See (💡 do " }, { text: "this)" }] }, DRAW]),
    states: ['it carries the typed "(💡 do this)".'],
    fix: group([{ ...WORDS, prompt: [{ text: "See " }] }, DRAW]),
  }, {
    // A ref inside typed brackets: both are named, the ref as the agent sent it.
    meets: group([{ ...WORDS, prompt: [{ text: "See [📎 a" }, { ref: 1 }, { text: "b]" }] }, DRAW]),
    states: ['it carries {"ref": 1}, the typed "[📎 a{"ref": 1}b]".'],
    fix: group([{ ...WORDS, prompt: [{ text: "See " }] }, DRAW]),
  }, {
    // Only a typed mark: it is named as typed, so the agent finds it in its words.
    meets: group([{ ...WORDS, prompt: [{ text: "Copy [📎 Pic] " }] }, DRAW]),
    states: ['it carries the typed "[📎 Pic]".'],
    fix: group([{ ...WORDS, prompt: [{ text: "Copy " }] }, DRAW]),
  }, {
    // A generation carries a note rightly: the fix acts on the written node only.
    meets: group([{ ...WORDS, prompt: [{ text: "Copy " }, NOTE] }, EMPTY_PIC, EDIT_POOL_1], [{ fromIndex: 1, toIndex: 2, into: "pool" }]),
    states: ['On node 0 ("Words"), take out every ref and note it carries'],
    fix: group([{ ...WORDS, prompt: [{ text: "Copy " }] }, EMPTY_PIC, EDIT_POOL_1], [{ fromIndex: 1, toIndex: 2, into: "pool" }]),
  }],
  "material-not-source": [{
    meets: group([{ ...DRAW, material: PIC }]),
    states: ["only a source image, video or audio node holds"],
  }],
  "material-not-ours": [{
    meets: group([{ ...HELD_PIC, material: ELSEWHERE }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['On node 0 ("Pic"), save a picture found on the web with save_image first'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }],
  "material-not-ours-media": [{
    meets: group([{ ...CLIP_HELD, material: "https://elsewhere.example/a.mp4" }, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }], fills: { video: [0] } })]),
    states: ['"Clip" holds an address that is not in our storage. A video node takes material only from our storage: a file the user uploaded in the chat.'],
  }, {
    meets: group([{ role: "source", type: "audio", name: "Track", material: "https://elsewhere.example/a.mp3" }, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })]),
    states: ["An audio node takes material only from our storage: a file the user uploaded in the chat."],
  }],
  "material-missing": [{
    // A mistyped address and one copied from another studio's canvas read the
    // same here, and each is put right differently, so no fix is written.
    meets: group([{ ...HELD_PIC, material: MISSING }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: [
      '"Pic" holds an address in our storage that is not registered in this studio.',
      "Material comes only from this studio's storage: files the user uploaded in the chat and pictures saved with save_image.",
    ],
  }],
  "material-wrong-kind": [{
    meets: group([{ ...HELD_PIC, material: CLIP }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['"Pic" is an image node and its material is video.'],
  }],
  "text-source": [{
    meets: group([{ role: "source", type: "text", name: "Copy" }, DRAW]),
    states: ['"Copy" is an empty text node, which the reader makes in one click; words go on a written node.'],
  }],
  "source-configured": [{
    meets: group([{ ...EMPTY_PIC, mode: "t2i" }, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ["takes no mode, model, params, fills, shots, or prompt; it carries mode."],
  }],
  "written-not-text": [{
    meets: group([{ ...WORDS, type: "image" }, DRAW]),
    states: ["a text node is the only one that holds those"],
  }],
  "written-configured": [{
    meets: group([{ ...WORDS, mode: "t2i" }, DRAW]),
    states: ["takes no mode, model, params, fills, or shots -- nothing is generated there; it carries mode."],
  }, {
    meets: group([{ ...WORDS, params: { duration: 5 } }, DRAW]),
    states: ["it carries params."],
  }],
  "written-empty": [{
    meets: group([{ ...WORDS, prompt: [{ text: "   " }] }, DRAW]),
    states: ["says it holds words and carries no words"],
  }],
  "mark-typed": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make it {✏️ mood}." }] })]),
    states: ['"Gen" types 1 mark(s) into its words as text: "{✏️ mood}". A mark works only as a segment of its own, with the text segments kept to plain words: {"slot": {"kind": "tweak", "label": "…", "note": "…"}} for words the reader writes.'],
  }, {
    // Brackets typed around a ref: quoted as written, the ref inside as the agent sent it.
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit [📎 " }, { ref: 0 }, { text: "] now." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Gen" types 1 mark(s) into its words as text: "[📎 {"ref": 0}]".', '{"ref": <index>} for a node'],
    absent: ["meant by"],
  }],
  "param-undeclared": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: [`"${ANGLES}" declares no format. The ones set here: ${ANGLES_SETTABLE.join(", ")}. On node 1 ("Gen"), leave "format" out of params.`],
    fix: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "param-from-list": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { voice_id: "Dennis" } })]),
    states: ["so it cannot be written here; which one to pick goes in a note. On node 0 (\"Gen\"), leave \"voice_id\" out of params."],
    fix: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }] })]),
  }],
  "param-box": [{
    meets: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }], params: { lyrics: "la la" } })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
    states: ['A written text node goes into "Gen" by an edge with into: "lyrics"', 'On node 1 ("Gen"), leave "lyrics" out of params.'],
    noCopies: "edge-repeated",
    fix: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
  }],
  "param-pool": [{
    meets: group([gen("image", "i2i", EDIT, { params: { images: PIC } })]),
    states: ['An image node holding material goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', 'On node 0 ("Gen"), leave "images" out of params.', 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first'],
    fix: group([gen("image", "i2i", EDIT)]),
  }],
  "param-slot": [{
    meets: group([gen("image", "i2i", EDIT, { params: { style_images: PIC } })]),
    states: ['An image node holding material goes into "Gen" through fills "style_images" on "Gen"', 'On node 0 ("Gen"), leave "style_images" out of params.', 'An empty image node goes into "Gen" by an edge with into: "style_images" and a note saying to pick it there and no ref'],
    fix: group([gen("image", "i2i", EDIT)]),
  }],
  "param-storyboard": [{
    meets: group([{ ...STORY, params: { duration: 5, multi_prompt: "x" } }]),
    states: ['"multi_prompt" is set by the node\'s shots. On node 0 ("Gen"), leave "multi_prompt" out of params.'],
    fix: group([STORY]),
  }],
  "param-storyboard-other-mode": [{
    meets: group([gen("video", "t2v", SHOTS, { params: { multi_prompt: "x" } })]),
    states: ['only the multi_shot mode takes. On node 0 ("Gen"), leave "multi_prompt" out of params.'],
    fix: group([gen("video", "t2v", SHOTS)]),
  }],
  "param-no-control": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { output_format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['On node 1 ("Gen"), leave "output_format" out of params.'],
    fix: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "param-gated-off": [{
    meets: group([gen("image", "t2i", T2I, { params: { camera: "ARRI Alexa 35" } })]),
    states: ['"camera" only counts while "enable_camera" is on, and this proposal leaves it off.'],
  }],
  "param-option": [{
    meets: group([gen("image", "t2i", T2I, { params: { aspect_ratio: "7:7" } })]),
    states: ['offers "1:1"'],
  }],
  "param-not-number": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { speed: "fast" } })]),
    states: ["takes a number"],
  }],
  "param-out-of-range": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { speed: 9 } })]),
    states: ["runs from 0.5 to 1.5"],
  }],
  "param-off-step": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { horizontal_angle: 50 } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ["so it takes 0, 45"],
  }],
  "edge-kind-not-taken": [{
    meets: group([HELD_PIC, DRAW, { ...gen("image", "i2i", EDIT), name: "Edit" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: [`"${T2I}" takes no image node, so the edge from "Pic" goes nowhere in it.`, '"Pic" goes into "Edit" by an edge with into: "pool" and a ref @\'ing it, or through fills "style_images" on "Edit", with no edge and no ref.'],
  }, {
    // An empty source is told the ways an empty node goes.
    meets: group([EMPTY_PIC, DRAW, { ...gen("image", "i2i", EDIT), name: "Edit" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Pic" goes into "Edit" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.'],
  }, {
    meets: group([HELD_PIC, { ...DRAW, name: "D1" }, { ...DRAW, name: "D2" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 2 }]),
    states: [`"${T2I}" takes no image node, so "Pic" has no way into "D2".`],
  }],
  "edge-kind-not-taken-link": [{
    meets: group([{ ...DRAW, name: "A" }, { ...DRAW, name: "B" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: [`"${T2I}" takes no image node, so the edge from "A" goes nowhere in it.`, "An edge that says no into stands as a creative link."],
  }],
  "edge-into-ambiguous": [{
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1 }]),
    states: ['The edge from "Pic" says no into, and "nano-banana-pro-edit-ultra" takes an image node more than one way.', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.'],
  }],
  "edge-not-an-entry": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT)], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]),
    states: ['"Pic" does not go into "style_images" of "Gen" by an edge.', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it, or through fills "style_images" on "Gen", with no edge and no ref.'],
  }],
  "fill-outside": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [5] } })]),
    states: ['fills "style_images" on "Gen" points at node 5, which is not in the group. On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }, {
    // A good index stands beside the bad one: only the bad one goes.
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 5] } })]),
    states: ['On node 1 ("Gen"), take every 5 out of fills "style_images".'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }, {
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [5, 5] } })]),
    states: ['fills "style_images" on "Gen" points at node 5, 2 times, which is not in the group.', 'On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-self": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [1] } })]),
    states: ['and a node cannot fill its own slot. On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }, {
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    states: ['On node 1 ("Gen"), take every 1 ("Gen") out of fills "style_images".'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }, {
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [1, 1] } })]),
    states: ['points at "Gen" itself, 2 times, and a node cannot fill its own slot.', 'On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-not-a-slot": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { nope: [0] } })]),
    states: [`"${EDIT}" has no slot "nope"; its slots: "style_images". On node 1 ("Gen"), take fills "nope" off.`],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-into-pool": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { images: [0] } })]),
    states: [`"images" is the reference pool of "${EDIT}", which takes no fills; its slots: "style_images". On node 1 ("Gen"), take fills "images" off.`],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-no-material": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['which holds no material, and fills takes only nodes holding it.', 'On node 1 ("Gen"), take fills "style_images" off.', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.'],
    fix: group([EMPTY_PIC, gen("image", "i2i", EDIT)]),
  }, {
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0] } })]),
    states: ['points at "Pic", 2 times, which holds no material', 'On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([EMPTY_PIC, gen("image", "i2i", EDIT)]),
  }, {
    meets: group([EMPTY_PIC, { ...HELD_PIC, name: "Held" }, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    states: ['On node 2 ("Gen"), take every 0 ("Pic") out of fills "style_images".'],
    fix: group([EMPTY_PIC, { ...HELD_PIC, name: "Held" }, gen("image", "i2i", EDIT, { fills: { style_images: [1] } })]),
  }],
  "fill-wrong-kind": [{
    meets: group([CLIP_HELD, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['On node 1 ("Gen"), take fills "style_images" off.', `"${EDIT}" takes no video node, so "Clip" has no way into "Gen".`],
    fix: group([CLIP_HELD, gen("image", "i2i", EDIT)]),
  }, {
    meets: group([CLIP_HELD, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0] } })]),
    states: ['and "Clip" is video and is named 2 times.', 'On node 1 ("Gen"), take fills "style_images" off.'],
    fix: group([CLIP_HELD, gen("image", "i2i", EDIT)]),
  }, {
    meets: group([CLIP_HELD, HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    states: ['On node 2 ("Gen"), take every 0 ("Clip") out of fills "style_images".'],
    fix: group([CLIP_HELD, HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [1] } })]),
  }],
  "fill-repeated": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0] } })]),
    states: ['names "Pic" 2 times', 'On node 1 ("Gen"), name it once in fills "style_images".'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }, {
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0, 0] } })]),
    states: ['names "Pic" 3 times'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }],
  "fill-twice": [{
    meets: group([HELD_PIC, { ...HELD_PIC, name: "Pic 2" }, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    states: ['fills "style_images" on "Gen" holds "Pic" and "Pic 2", which hold the same material, and the slot keeps one copy of it.'],
  }],
};

/**
 * Hold a fix proposal to the place its sentence names: a node fix leaves every
 * other node and every edge as it was; an edge fix takes off only the edges
 * between its two ends; the group's fix leaves nodes and edges alone.
 * @param meets - The proposal refused.
 * @param fix - The proposal after the fix.
 * @param sentence - The fix as the reason ends on it.
 */
function actsWhereItSays(meets: Sent, fix: Sent, sentence: string): void {
  const onNode = /^On node (\d+) /.exec(sentence);
  if (onNode) {
    const at = Number(onNode[1]);
    expect(fix.nodes.filter((_, i) => i !== at), `"${sentence}" leaves the other nodes alone`).toEqual(meets.nodes.filter((_, i) => i !== at));
    expect(fix.edges, `"${sentence}" leaves the edges alone`).toEqual(meets.edges);
    return;
  }
  const between = /^Take every edge from node (\d+) \(.*?\) to (?:node (\d+) \(.*?\)|itself) off\.$/.exec(sentence);
  expect(fix.nodes, `"${sentence}" leaves the nodes alone`).toEqual(meets.nodes);
  if (between) {
    const from = Number(between[1]);
    const to = between[2] === undefined ? from : Number(between[2]);
    expect(fix.edges, `"${sentence}" takes off only those edges`).toEqual(meets.edges.filter((e) => e.fromIndex !== from || e.toIndex !== to));
    return;
  }
  expect(fix.edges, `"${sentence}" leaves the edges alone`).toEqual(meets.edges);
}

/**
 * Hold the fix of a template edge sent the wrong way (inner#1345) to what it
 * says: the same edges, one of them saying another into, and only the node it
 * goes into changed besides, where its ref or note goes.
 * @param meets - The proposal refused.
 * @param fix - The proposal after the fix.
 */
function rewiresOneEdge(meets: Sent, fix: Sent): void {
  expect(fix.edges.map((e) => [e.fromIndex, e.toIndex]), "the fix keeps every edge's ends").toEqual(meets.edges.map((e) => [e.fromIndex, e.toIndex]));
  const changed = fix.edges.filter((e, i) => e.into !== meets.edges[i]?.into);
  expect(changed, "the fix changes one edge's into").toHaveLength(1);
  const into = (changed[0] as Sent["edges"][number]).toIndex;
  expect(fix.nodes.filter((_, i) => i !== into), "the fix leaves every node but the one wired into alone").toEqual(meets.nodes.filter((_, i) => i !== into));
}

/**
 * Hold the fix of a missing template edge (design 6.7 step 3) to what it
 * says: one edge added into node j, and only node j changed besides, where
 * the ref (or, into a slot, the note) goes. Every other edge stays.
 * @param meets - The proposal refused.
 * @param fix - The proposal after the fix.
 */
function wiresOneEdgeIn(meets: Sent, fix: Sent): void {
  const added = [...fix.edges];
  for (const edge of meets.edges) {
    const at = added.findIndex((e) => JSON.stringify(e) === JSON.stringify(edge));
    expect(at, "the fix keeps every edge the proposal had").toBeGreaterThanOrEqual(0);
    added.splice(at, 1);
  }
  expect(added, "the fix adds one edge").toHaveLength(1);
  const into = (added[0] as Sent["edges"][number]).toIndex;
  expect(fix.nodes.filter((_, i) => i !== into), "the fix leaves every node but the one wired into alone").toEqual(meets.nodes.filter((_, i) => i !== into));
}

describe("every refusal states its fault, its rule and its facts", () => {
  for (const [refusal, cases] of Object.entries(CASES) as [RefusalId, RefusalCase[]][]) {
    for (const [at, entry] of cases.entries()) {
      it(`${refusal} (${String(at)}): is met and says what is wrong${REFUSALS[refusal] === false ? "" : ", and its one fix clears it"}`, () => {
        entry.catalog?.();
        // Every proposal here is one the tool would take in, so a fix is proven on what the agent can send.
        expect(inputSchema.safeParse(entry.meets).success, "the met proposal passes the tool's schema").toBe(true);
        if (entry.fix !== undefined) expect(inputSchema.safeParse(entry.fix).success, "the fixed proposal passes the tool's schema").toBe(true);
        const met = verdictFor(entry.meets, MATERIALS, entry.templates);
        expect(met).toMatchObject({ ok: false, refusal });
        const reason = met.ok ? "" : met.reason;
        // The words are pinned so a changed reason is read in review.
        expect(reason).toMatchSnapshot();
        for (const statement of entry.states) expect(reason).toContain(statement);
        for (const words of entry.absent ?? []) expect(reason).not.toContain(words);
        // A fix is written only where the table marks the refusal as having one.
        expect(entry.fix !== undefined, `${refusal} carries a fix exactly when REFUSALS marks one`).toBe(REFUSALS[refusal] !== false);
        if (entry.fix === undefined) return;
        const after = verdictFor(entry.fix, MATERIALS, entry.templates);
        expect(after.ok ? undefined : after.refusal, `following the fix of "${reason}"`).not.toBe(refusal);
        // A template edge's fix names everything its route asks, so the proposal then stands.
        if (refusal === "template-edge-missing" || refusal === "template-edge-into") expect(after, `following the fix of "${reason}"`).toEqual({ ok: true });
        // The fix proposal changes only what the sentence names.
        if (refusal === "template-edge-missing") wiresOneEdgeIn(entry.meets, entry.fix);
        else if (refusal === "template-edge-into") rewiresOneEdge(entry.meets, entry.fix);
        else actsWhereItSays(entry.meets, entry.fix, lastSentence(reason));
      });
    }
  }
});

/** One way of writing a proposal's named elements more than once. */
type Doubling = (sent: Sent) => Sent;

/**
 * The proposal with every ref and note segment and every fill index written
 * twice, or a prompt's words written twice where they type a mark.
 * @param sent - The proposal.
 * @returns The doubled proposal.
 */
function doubledMarks(sent: Sent): Sent {
  // Typed marks are found by the check's own reading, so a mark typed across
  // segments is written twice by writing the words twice.
  const twice = (segments: NonNullable<Sent["nodes"][number]["prompt"]>): NonNullable<Sent["nodes"][number]["prompt"]> =>
    !markTypedAsWords({ role: "written", type: "text", name: "", prompt: segments }).ok
      ? [...segments, ...segments]
      : segments.flatMap((s): typeof segments => ("ref" in s || ("slot" in s && s.slot.kind === "note") ? [s, s] : [s]));
  return {
    ...sent,
    nodes: sent.nodes.map((node) => ({
      ...node,
      ...(node.prompt === undefined ? {} : { prompt: twice(node.prompt) }),
      ...(node.shots === undefined ? {} : { shots: node.shots.map((shot) => ({ ...shot, prompt: twice(shot.prompt) })) }),
      ...(node.fills === undefined ? {} : { fills: Object.fromEntries(Object.entries(node.fills).map(([k, v]) => [k, v.flatMap((at) => [at, at])])) }),
    })),
  };
}

/**
 * The proposal with every edge written twice.
 * @param sent - The proposal.
 * @returns The doubled proposal.
 */
function doubledEdges(sent: Sent): Sent {
  return { ...sent, edges: sent.edges.flatMap((edge) => [edge, edge]) };
}

/**
 * The fix a reason ends on: its last sentence.
 * @param reason - The reason.
 * @returns The last sentence.
 */
function lastSentence(reason: string): string {
  return reason.slice(reason.lastIndexOf(". ", reason.length - 2) + 2);
}

describe("a fix names what to take out by value, so the copies of it do not change it", () => {
  const doublings: Doubling[] = [doubledMarks, doubledEdges];
  for (const [refusal, cases] of Object.entries(CASES) as [RefusalId, RefusalCase[]][]) {
    if (REFUSALS[refusal] === false) continue;
    for (const [at, entry] of cases.entries()) {
      // A doubling that leaves the proposal as it was proves nothing, and a
      // case no doubling changes has nothing written twice to name.
      const changing = doublings.filter((double) => JSON.stringify(double(entry.meets)) !== JSON.stringify(entry.meets));
      if (changing.length === 0) continue;
      it(`${refusal} (${String(at)}): ends on the same fix with its elements written twice`, () => {
        entry.catalog?.();
        const once = verdictFor(entry.meets, MATERIALS, entry.templates);
        // Writing everything twice can trip an earlier check first, so each case
        // has to meet its own refusal under one doubling that changes it at least,
        // or name in noCopies the refusal every doubling meets first instead.
        const verdicts = changing.map((double) => verdictFor(double(entry.meets), MATERIALS, entry.templates));
        if (entry.noCopies !== undefined) {
          for (const verdict of verdicts) expect(verdict).toMatchObject({ ok: false, refusal: entry.noCopies });
          return;
        }
        const reached = verdicts.flatMap((verdict) => (!verdict.ok && verdict.refusal === refusal ? [verdict.reason] : []));
        expect(reached.length, `${refusal} (${String(at)}) meets its own refusal under some doubling`).toBeGreaterThan(0);
        for (const reason of reached) expect(lastSentence(reason)).toBe(lastSentence(once.ok ? "" : once.reason));
      });
    }
  }
});
