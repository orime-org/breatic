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
import { findTemplate, templatePrompt, type ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useEnvWithKeys, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { verdictFor, type MaterialFacts, type MaterialTable } from "../propose-canvas-action.js";
import { REFUSALS, type RefusalId } from "../proposal-refusals.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
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
  return templatePrompt(findTemplate("storyboard-grid-25") as NonNullable<ReturnType<typeof findTemplate>>).map((segment) => {
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
    states: ["An edge points outside the group", "Take that edge off."],
    fix: group([DRAW]),
  }],
  "edge-self-loop": [{
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 0 }]),
    states: ["An edge loops node 0 onto itself.", "Take that edge off."],
    fix: group([DRAW]),
  }],
  "edge-repeated": [{
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['Two edges run from "Pic" to "Gen" (into "pool", into "pool")', "a node goes into a generation one way"],
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
    states: ["The canvas does not let a video node feed an audio node", "Take that edge off.", '"Clip" goes into "Gen" unwired, with a note saying to pick it into "video" and no ref.'],
    fix: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })]),
  }, {
    meets: group([CLIP_EMPTY, gen("image", "i2i", EDIT)], [{ fromIndex: 0, toIndex: 1 }]),
    states: ["Take that edge off.", '"nano-banana-pro-edit-ultra" takes no video node, so "Clip" has no way into "Gen".'],
    fix: group([CLIP_EMPTY, gen("image", "i2i", EDIT)]),
  }, {
    // The generation names no model the catalog serves: the canvas rule is all there is to say.
    meets: group([CLIP_EMPTY, gen("image", "i2i", "no-such-model")], [{ fromIndex: 0, toIndex: 1 }]),
    states: ["The canvas does not let a video node feed an image node, by your hand or theirs. Take that edge off."],
    fix: group([CLIP_EMPTY, gen("image", "i2i", "no-such-model")]),
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
    states: ["give the group a name"],
    fix: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "template-unknown": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, template: "no-such-template", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['No template "no-such-template". Templates: storyboard-grid-25'],
  }],
  "template-role": [{
    meets: group([{ ...EMPTY_PIC, template: "storyboard-grid-25" }, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['Template "storyboard-grid-25" goes on a generate node; "Pic" is a source node.'],
  }],
  "template-type": [{
    meets: group([gen("video", "t2v", SHOTS, { template: "storyboard-grid-25" })]),
    states: ['Template "storyboard-grid-25" is for image nodes, not video.'],
  }],
  "template-no-prompt": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, prompt: undefined, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Gen" names template "storyboard-grid-25" and sends no prompt. Give it a prompt.', "The template's prompt, to rewrite in the reader's language with their story or detail in it:", 'an empty one by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first'],
    fix: group([EMPTY_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined, prompt: [...storyboardSegments(), NOTE] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
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
    states: ['Shots belong to the multi_shot mode, and "Gen" runs "t2v". Leave shots out.'],
    fix: group([gen("video", "t2v", SHOTS, { prompt: undefined })]),
  }],
  "multishot-no-shots": [{
    meets: group([gen("video", "multi_shot", SHOTS, { params: { duration: 5 } })]),
    states: ["In the multi_shot mode the shots are what is generated. Give shots"],
    fix: group([STORY]),
  }],
  "shots-with-prompt": [{
    meets: group([{ ...STORY, prompt: [{ text: "Make it." }] }]),
    states: ["With shots the main prompt is not sent; its words, refs and notes go in the shots. Leave prompt out."],
    fix: group([STORY]),
  }],
  "no-prompt-box": [{
    meets: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [{ text: "Talk." }, NOTE] })]),
    states: [`"${HEAD}" draws no prompt box`, "Keep only notes"],
    fix: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [NOTE] })]),
  }],
  "ref-outside": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 7 }] })]),
    states: ['A ref in "Gen" points outside the group: {"ref": 7}. Take that ref out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
  }],
  "ref-self": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 0 }] })]),
    states: ['"Gen" @s itself with {"ref": 0}, and a node cannot @ itself. Take that ref out.'],
    fix: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }] })]),
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
  }],
  "ref-not-pooled-no-pool": [{
    meets: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, { ref: 0 }, NOTE] })]),
    states: ['"nano-banana-2" has no pool for an image node. Leave the ref out.', '"nano-banana-2" takes no image node, so "Pic" has no way into "Gen".'],
    fix: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, NOTE] })]),
  }, {
    meets: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score " }, { ref: 0 }] })]),
    states: ["Leave the ref out.", '"Clip" goes into "Gen" through fills "video" on "Gen", with no edge and no ref.'],
    fix: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score " }] })]),
  }],
  "way-over-room": [{
    meets: group(PICS(4).concat([gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, ...REFS(4), ...NOTES(4)] })]), [0, 1, 2, 3].map((i) => ({ fromIndex: i, toIndex: 4, into: "pool" }))),
    states: [`"${ANGLES}" takes 3 image node(s) by "pool", and 4 are going that way ("Pic 0", "Pic 1", "Pic 2", "Pic 3").`, 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first.'],
  }, {
    // Over the pool with another way open: the other way is said as a rule, with its room and who holds it.
    meets: group(PICS(12).concat([gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(12), ...NOTES(12)] })]), Array.from({ length: 12 }, (_, i) => ({ fromIndex: i, toIndex: 12, into: "pool" }))),
    states: [`"${EDIT}" takes 11 image node(s) by "pool", and 12 are going that way`, 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.', '"style_images" takes 3 and holds none.'],
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
    states: ['by "melody", and 3 are going that way ("A", "X", "C")', '"vocal" takes 1 and holds "X".'],
  }],
  "ref-missing": [{
    meets: group([WORDS, { ...STORY }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Words" is wired into the pool of "Gen" and no ref @s it. A node in the pool is used only where a ref @s it in the shot: {"ref": 0}.'],
  }],
  "notes-missing": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ['"Gen" needs a note for each of "Pic"', "and carries 0"],
  }],
  "shot-empty": [{
    meets: group([{ ...STORY, shots: [{ prompt: [], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    states: ["Shot 1 writes nothing. Every shot needs its own words."],
  }],
  "too-many-shots": [{
    meets: group([{ ...STORY, params: { duration: 7 }, shots: Array.from({ length: 7 }, (_, i) => ({ prompt: [{ text: `Shot ${String(i)}.` }], duration: 1 })) }]),
    states: [`"${SHOTS}" takes at most 6 shots, and their seconds add up to duration.`],
  }],
  "shot-too-long": [{
    meets: group([{ ...STORY, shots: [{ prompt: [{ text: LONG_SCRIPT }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    states: ["Shot 1 is longer than the"],
  }],
  "shots-duration": [{
    meets: group([{ ...STORY, params: { duration: 8 } }]),
    states: ["The shots add up to 5 seconds and duration is 8."],
  }],
  "prompt-missing": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [] })]),
    states: [`"${T2I}" generates from what the prompt says, and this proposal writes nothing in it. Write a prompt.`],
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
    states: ['"Words" holds words the reader keeps as they are, so it takes no ref or note. Take it out'],
    fix: group([WORDS, DRAW]),
  }],
  "material-not-source": [{
    meets: group([{ ...DRAW, material: PIC }]),
    states: ["only a source image, video or audio node holds"],
  }],
  "material-not-ours": [{
    meets: group([{ ...HELD_PIC, material: ELSEWHERE }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ["Save a picture found on the web with save_image first"],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }],
  "material-missing": [{
    meets: group([{ ...HELD_PIC, material: MISSING }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ["Copy it again exactly"],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
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
    states: ["takes no mode, model, parameters, fills, shots or prompt"],
  }],
  "written-not-text": [{
    meets: group([{ ...WORDS, type: "image" }, DRAW]),
    states: ["a text node is the only one that holds those"],
  }],
  "written-configured": [{
    meets: group([{ ...WORDS, mode: "t2i" }, DRAW]),
    states: ["takes no mode, model, fills or shots"],
  }],
  "written-empty": [{
    meets: group([{ ...WORDS, prompt: [{ text: "   " }] }, DRAW]),
    states: ["says it holds words and carries no words"],
  }],
  "mark-typed": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make it {✏️ mood}." }] })]),
    states: ['"Gen" types 1 mark(s) into its words, and a mark works only as a segment of its own, with the text segments kept to plain words:'],
  }],
  "param-undeclared": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: [`"${ANGLES}" declares no format. The ones set here: ${ANGLES_SETTABLE.join(", ")}. Leave "format" out.`],
    fix: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
  }],
  "param-from-list": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { voice_id: "Dennis" } })]),
    states: ["so it cannot be written here; which one to pick goes in a note. Leave it out."],
    fix: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }] })]),
  }],
  "param-box": [{
    meets: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }], params: { lyrics: "la la" } })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
    states: ['Leave it out. A written text node goes into "Gen" by an edge with into: "lyrics"'],
    fix: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
  }],
  "param-pool": [{
    meets: group([gen("image", "i2i", EDIT, { params: { images: PIC } })]),
    states: ['Leave it out. An image node holding material goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first'],
    fix: group([gen("image", "i2i", EDIT)]),
  }],
  "param-slot": [{
    meets: group([gen("image", "i2i", EDIT, { params: { style_images: PIC } })]),
    states: ['Leave it out. An image node holding material goes into "Gen" through fills "style_images" on "Gen"', 'An empty image node goes into "Gen" by an edge with into: "style_images" and a note saying to pick it there and no ref'],
    fix: group([gen("image", "i2i", EDIT)]),
  }],
  "param-storyboard": [{
    meets: group([{ ...STORY, params: { duration: 5, multi_prompt: "x" } }]),
    states: ['"multi_prompt" is set by the node\'s shots. Leave it out of params.'],
    fix: group([STORY]),
  }],
  "param-storyboard-other-mode": [{
    meets: group([gen("video", "t2v", SHOTS, { params: { multi_prompt: "x" } })]),
    states: ["only the multi_shot mode takes. Leave it out"],
    fix: group([gen("video", "t2v", SHOTS)]),
  }],
  "param-no-control": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { output_format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    states: ["Leave it out"],
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
    states: ['fills "style_images" on "Gen" points at node 5, which is not in the group. Take it out of fills "style_images".'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [] } })]),
  }],
  "fill-self": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [1] } })]),
    states: ['and a node cannot fill its own slot. Take it out of fills "style_images".'],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [] } })]),
  }],
  "fill-not-a-slot": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { nope: [0] } })]),
    states: [`"${EDIT}" has no slot "nope"; its slots: "style_images". Take fills "nope" off.`],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-into-pool": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { images: [0] } })]),
    states: [`"images" is the reference pool of "${EDIT}", which takes no fills; its slots: "style_images". Take fills "images" off.`],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT)]),
  }],
  "fill-no-material": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['which holds no material, and fills takes only nodes holding it. Take "Pic" out of fills "style_images".', '"Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first, or by an edge with into: "style_images" and a note saying to pick it there and no ref.'],
    fix: group([EMPTY_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [] } })]),
  }],
  "fill-wrong-kind": [{
    meets: group([CLIP_HELD, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    states: ['Take "Clip" out of fills "style_images".', `"${EDIT}" takes no video node, so "Clip" has no way into "Gen".`],
    fix: group([CLIP_HELD, gen("image", "i2i", EDIT, { fills: { style_images: [] } })]),
  }],
  "fill-repeated": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0] } })]),
    states: ["Name it once."],
    fix: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
  }],
  "fill-twice": [{
    meets: group([HELD_PIC, { ...HELD_PIC, name: "Pic 2" }, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    states: ['fills "style_images" on "Gen" holds "Pic" and "Pic 2", which hold the same material, and the slot keeps one copy of it.'],
  }],
};

describe("every refusal states its fault, its rule and its facts", () => {
  for (const [refusal, cases] of Object.entries(CASES) as [RefusalId, RefusalCase[]][]) {
    for (const [at, entry] of cases.entries()) {
      it(`${refusal} (${String(at)}): is met and says what is wrong${REFUSALS[refusal] ? ", and its one fix clears it" : ""}`, () => {
        entry.catalog?.();
        const met = verdictFor(entry.meets, MATERIALS);
        expect(met).toMatchObject({ ok: false, refusal });
        const reason = met.ok ? "" : met.reason;
        // The words are pinned so a changed reason is read in review.
        expect(reason).toMatchSnapshot();
        for (const statement of entry.states) expect(reason).toContain(statement);
        // A fix is written only where the table marks the refusal as having one.
        expect(entry.fix !== undefined, `${refusal} carries a fix exactly when REFUSALS marks one`).toBe(REFUSALS[refusal]);
        if (entry.fix === undefined) return;
        const after = verdictFor(entry.fix, MATERIALS);
        expect(after.ok ? undefined : after.refusal, `following the fix of "${reason}"`).not.toBe(refusal);
      });
    }
  }
});
