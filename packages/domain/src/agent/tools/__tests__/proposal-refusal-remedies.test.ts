// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every refusal the proposal check gives, held to its own advice: a proposal
 * that meets it, and for each way the reason says to put it right, the
 * proposal that does exactly that and nothing else -- which the check has to
 * accept. The table is keyed by refusal name, so a refusal added without its
 * case does not compile (inner#1315).
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadLocales } from "@breatic/core";
import { findTemplate, templatePrompt, type ProposalNode } from "@breatic/shared";

import { restoreProcessEnv, useEnvWithKeys, useFullCatalog } from "@domain/model-catalog/__tests__/catalog-env.js";

import { verdictFor, type MaterialFacts, type MaterialTable } from "../propose-canvas-action.js";
import type { RefusalId } from "../proposal-refusals.js";

beforeEach(() => {
  loadLocales();
  useFullCatalog();
});

afterAll(() => {
  restoreProcessEnv();
});

/** What the model sends, as the tool's input. */
type Sent = Parameters<typeof verdictFor>[0];

/** One refusal: what meets it, and what each piece of its advice builds. */
interface RefusalCase {
  /** A proposal the check refuses with this refusal. */
  meets: Sent;
  /**
   * One proposal per way the reason says to put it right, each doing that and
   * nothing else, with the words of the reason it follows. Where the reason
   * names no fix, the one its words leave is followed and says is left out.
   */
  followed: { says: string | undefined; proposal: Sent }[];
  /** Advice the reason gives that is answered in the reply rather than on the canvas. */
  inTheReply?: string;
  /** The catalog the case is met under, where it is not the full one. */
  catalog?: () => void;
  /** The words the reason ends on, where advice added after them would be wrong. */
  endsOn?: string;
}

const PIC = "https://resource.example/image/2026-10-09/1_pic.png";
const CLIP = "https://resource.example/video/2026-10-09/1_clip.mp4";
const ELSEWHERE = "https://elsewhere.example/a.png";
const MISSING = "https://resource.example/image/2026-10-09/1_typo.png";
const CLIP_IMAGE = "https://resource.example/image/2026-10-09/2_frame.png";

const MEDIA = { coverUrl: null, width: 640, height: 480, duration: 3, mimeType: "image/png", size: 100 };
const MATERIALS: MaterialTable = new Map<string, MaterialFacts | "missing">([
  [PIC, { kind: "image", media: MEDIA }],
  [CLIP_IMAGE, { kind: "image", media: MEDIA }],
  [CLIP, { kind: "video", media: { ...MEDIA, mimeType: "video/mp4" } }],
  [MISSING, "missing"],
]);

const T2I = "nano-banana-2";
const EDIT = "nano-banana-pro-edit-ultra";
const ANGLES = "qwen-image-edit-multiple-angles";
const HEAD = "omnihuman-1.5";
const SCORE = "sonilo-video-to-music";
const SONG = "mureka-v9.5-generate-song";
const TTS = "realtime-tts-2";
const LONG_TTS = "minimax-speech-2.8-hd";
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

/** The values the multiple-angles model has a control for, each set to a value it takes. */
const ANGLES_SETTABLE: Record<string, number> = { distance: 2, horizontal_angle: 45, vertical_angle: 30 };

// The template's words are read from the locales while the cases are built.
loadLocales();

const CASES: Record<RefusalId, RefusalCase[]> = {
  "nothing-generates": [{
    meets: { nodes: [EMPTY_PIC], edges: [], rationale: "r" },
    followed: [{ says: 'Propose what gets made', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
    inTheReply: "say in your reply what they should do",
  }],
  "nothing-generates-words": [{
    meets: { nodes: [WORDS], edges: [], rationale: "r" },
    followed: [],
    inTheReply: "Write them in your reply",
  }],
  "edge-outside": [{
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 4 }]),
    followed: [{ says: undefined, proposal: group([DRAW]) }],
  }],
  "edge-self-loop": [{
    meets: group([DRAW], [{ fromIndex: 0, toIndex: 0 }]),
    followed: [{ says: undefined, proposal: group([DRAW]) }],
  }],
  "edge-repeated": [{
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'Send one edge', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "edge-into-nothing-generating": [{
    meets: group([DRAW, WORDS], [{ fromIndex: 0, toIndex: 1 }]),
    followed: [{ says: undefined, proposal: group([DRAW, WORDS]) }],
  }],
  "edge-not-allowed": [{
    meets: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }] })], [{ fromIndex: 0, toIndex: 1 }]),
    followed: [{ says: 'leave this edge off. "Clip" goes into "Gen" unwired, with a note saying to pick it into "video" and no ref', proposal: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }, NOTE] })]) }],
  }, {
    meets: group([CLIP_EMPTY, gen("image", "i2i", EDIT)], [{ fromIndex: 0, toIndex: 1 }]),
    followed: [
      { says: 'leave this edge off. "nano-banana-pro-edit-ultra" takes no video node, so "Clip" has no way into "Gen". No generation here has a way left for a video node; take "Clip" out', proposal: group([gen("image", "i2i", EDIT)]) },
      { says: "or propose a model that takes it", proposal: group([CLIP_EMPTY, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }, NOTE] })]) },
    ],
  }],
  "edge-ring": [{
    meets: group(
      [gen("image", "i2i", EDIT, { name: "A", prompt: [{ text: "From " }, { ref: 1 }, NOTE] }), gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "From " }, { ref: 0 }, NOTE] })],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 1, toIndex: 0, into: "pool" }],
    ),
    followed: [{ says: undefined, proposal: group(
      [gen("image", "i2i", EDIT, { name: "A", prompt: [{ text: "Make it." }], mode: "t2i", model: T2I }), gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "From " }, { ref: 0 }, NOTE] })],
      [{ fromIndex: 0, toIndex: 1, into: "pool" }],
    ) }],
  }],
  "group-unnamed": [{
    meets: { nodes: [EMPTY_PIC, EDIT_POOL], edges: [{ fromIndex: 0, toIndex: 1, into: "pool" }], rationale: "r" },
    followed: [{ says: 'give the group a name', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "template-unknown": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, template: "no-such-template", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'Templates: storyboard-grid-25', proposal: group([EMPTY_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "template-role": [{
    meets: group([{ ...EMPTY_PIC, template: "storyboard-grid-25" }, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'goes on a generate node', proposal: group([EMPTY_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "template-type": [{
    meets: group([gen("video", "t2v", SHOTS, { template: "storyboard-grid-25" })]),
    followed: [{ says: 'is for image nodes', proposal: group([EMPTY_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "template-no-prompt": [{
    meets: group([EMPTY_PIC, { ...EDIT_POOL, prompt: undefined, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{
      says: 'an empty one by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first',
      proposal: group([EMPTY_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined, prompt: [...storyboardSegments(), NOTE] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    }],
  }, {
    meets: group([HELD_PIC, { ...EDIT_POOL, prompt: undefined, template: "storyboard-grid-25", mode: undefined, model: undefined }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{
      says: 'A node holding material or words goes into "Gen" by an edge with into: "pool" and a ref @\'ing it',
      proposal: group([HELD_PIC, { ...EDIT_POOL, template: "storyboard-grid-25", mode: undefined, model: undefined, prompt: storyboardSegments() }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    }],
  }],
  "sources-no-taker": [{
    meets: group([EMPTY_PIC, DRAW]),
    followed: [{ says: undefined, proposal: group([DRAW]) }],
  }],
  "sources-over-room": [{
    meets: group([EMPTY_PIC, { ...EMPTY_PIC, name: "Pic 2" }, gen("video", "talking_head", HEAD, { prompt: [NOTE, NOTE] })]),
    followed: [{ says: undefined, proposal: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [NOTE] })]) }],
  }],
  "material-unused": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Make it." }] })]),
    followed: [{ says: 'Send it into a generation that takes it: "Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }, { says: 'through fills "style_images" on "Gen", with no edge and no ref', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }, {
    meets: group([{ ...DRAW, name: "Draw" }, gen("video", "i2v", VID, { name: "Vid", prompt: [{ text: "Move it." }, NOTE] }), { ...HELD_PIC, name: "B" }], [{ fromIndex: 0, toIndex: 1, into: "image" }]),
    followed: [
      { says: 'take "B" out', proposal: group([{ ...DRAW, name: "Draw" }, gen("video", "i2v", VID, { name: "Vid", prompt: [{ text: "Move it." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "image" }]) },
      { says: "or propose a model that takes it", proposal: group([{ ...DRAW, name: "Draw" }, gen("video", "i2v", VID, { name: "Vid", prompt: [{ text: "Move it." }, NOTE] }), { ...HELD_PIC, name: "B" }, gen("image", "i2i", EDIT, { name: "Edit", fills: { style_images: [2] } })], [{ fromIndex: 0, toIndex: 1, into: "image" }]) },
    ],
  }, {
    meets: group([HELD_PIC, { ...HELD_PIC, name: "Pic 2" }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [{ says: 'Send it into a generation that takes it: "Pic 2" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it.', proposal: group([HELD_PIC, { ...HELD_PIC, name: "Pic 2" }, gen("image", "i2i", EDIT, { fills: { style_images: [0] }, prompt: [{ text: "Edit " }, { ref: 1 }] })], [{ fromIndex: 1, toIndex: 2, into: "pool" }]) }],
  }],
  "loose-without-note": [{
    meets: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: undefined })]),
    followed: [{ says: 'Give each one a note saying which slot to pick it into', proposal: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [NOTE] })]) }],
  }],
  "text-generates": [{
    meets: group([{ role: "generate", type: "text", name: "Copy", prompt: [{ text: "Write it." }] }, DRAW]),
    followed: [{ says: 'send it as a written node', proposal: group([WORDS, DRAW]) }],
  }],
  "no-mode-model": [{
    meets: group([gen("image", "t2i", T2I, { mode: undefined })]),
    followed: [{ says: 'it needs a mode and a model', proposal: group([DRAW]) }],
  }],
  "mode-unbacked": [{
    meets: group([gen("image", "no-such-mode", T2I)]),
    followed: [{ says: 'It offers: t2i', proposal: group([DRAW]) }],
  }],
  "no-model-for-kind": [{
    catalog: () => useEnvWithKeys([]),
    meets: group([gen("video", "t2v", SHOTS)]),
    followed: [],
    inTheReply: "Say so in your reply",
  }],
  "model-not-in-mode": [{
    meets: group([gen("image", "t2i", EDIT)]),
    followed: [{ says: 'Those that do:', proposal: group([DRAW]) }],
  }],
  "shots-outside-multishot": [{
    meets: group([gen("video", "t2v", SHOTS, { prompt: undefined, shots: TWO_SHOTS })]),
    followed: [{ says: 'Propose mode "multi_shot"', proposal: group([STORY]) }, { says: 'or leave shots out', proposal: group([gen("video", "t2v", SHOTS)]) }],
  }],
  "multishot-no-shots": [{
    meets: group([gen("video", "multi_shot", SHOTS, { params: { duration: 5 } })]),
    followed: [{ says: 'Give shots', proposal: group([STORY]) }],
  }],
  "shots-with-prompt": [{
    meets: group([{ ...STORY, prompt: [{ text: "Make it." }] }]),
    followed: [{ says: 'Put its words, refs and notes into the shots and leave prompt out', proposal: group([STORY]) }],
  }],
  "no-prompt-box": [{
    meets: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [{ text: "Talk." }, NOTE] })]),
    followed: [{ says: 'Keep only notes', proposal: group([EMPTY_PIC, gen("video", "talking_head", HEAD, { prompt: [NOTE] })]) }],
  }],
  "ref-outside": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 7 }] })]),
    followed: [{ says: undefined, proposal: group([DRAW]) }],
  }],
  "ref-self": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make " }, { ref: 0 }] })]),
    followed: [{ says: 'Check the index the ref means', proposal: group([DRAW]) }],
  }],
  "ref-arrives-otherwise": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] }, prompt: [{ text: "In the style of " }, { ref: 0 }] })]),
    followed: [{ says: 'through fills "style_images" on "Gen", with no edge and no ref, so leave the ref out', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] }, prompt: [{ text: "In the style of it." }] })]) }],
  }, {
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Style of " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]),
    followed: [{ says: 'by an edge with into: "style_images" and a note saying to pick it there and no ref, so leave the ref out', proposal: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Style of it." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]) }],
  }, {
    meets: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop for " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
    followed: [{ says: 'by an edge with into: "lyrics", which landing @s into that box, and no ref, so leave the ref out', proposal: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]) }],
  }],
  "ref-not-pooled": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })]),
    followed: [
      { says: 'To keep the ref, send it into the pool that way', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      { says: 'by an edge with into: "style_images" and a note saying to pick it there and no ref. To keep the ref, send it into the pool that way; otherwise leave the ref out', proposal: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]) },
    ],
  }],
  "ref-not-pooled-no-pool": [{
    meets: group([EMPTY_PIC, gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, { ref: 0 }, NOTE] })]),
    followed: [
      { says: 'Leave the ref out. "nano-banana-2" takes no image node, so "Pic" has no way into "Gen". No generation here has a way left for an image node; take "Pic" out', proposal: group([gen("image", "t2i", T2I, { prompt: [{ text: "Draw " }, NOTE] })]) },
      { says: "or propose a model that takes it", proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
    ],
  }, {
    meets: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score " }, { ref: 0 }] })]),
    followed: [{ says: 'Leave the ref out. "Clip" goes into "Gen" through fills "video" on "Gen", with no edge and no ref', proposal: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }], fills: { video: [0] } })]) }],
  }],
  "way-over-room": [{
    meets: group(
      [0, 1, 2, 3].map((i) => ({ ...EMPTY_PIC, name: `Pic ${String(i)}` })).concat([gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, { ref: 1 }, { ref: 2 }, { ref: 3 }, NOTE, NOTE, NOTE, NOTE] })]),
      [0, 1, 2, 3].map((i) => ({ fromIndex: i, toIndex: 4, into: "pool" })),
    ),
    followed: [{ says: 'Send fewer', proposal: group(
      [0, 1, 2].map((i) => ({ ...EMPTY_PIC, name: `Pic ${String(i)}` })).concat([gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, { ref: 1 }, { ref: 2 }, NOTE, NOTE, NOTE] })]),
      [0, 1, 2].map((i) => ({ fromIndex: i, toIndex: 3, into: "pool" })),
    ) }],
  }],
  "way-over-room-other-way": [{
    meets: group(
      PICS(12).concat([gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(12), ...NOTES(12)] })]),
      Array.from({ length: 12 }, (_, i) => ({ fromIndex: i, toIndex: 12, into: "pool" })),
    ),
    followed: [
      { says: "Send fewer", proposal: group(
        PICS(11).concat([gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(11), ...NOTES(11)] })]),
        Array.from({ length: 11 }, (_, i) => ({ fromIndex: i, toIndex: 11, into: "pool" })),
      ) },
      { says: 'or send the rest another way: "Pic 11" goes into "Gen" by an edge with into: "style_images" and a note saying to pick it there and no ref', proposal: group(
        PICS(12).concat([gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, ...REFS(11), ...NOTES(12)] })]),
        [...Array.from({ length: 11 }, (_, i) => ({ fromIndex: i, toIndex: 12, into: "pool" })), { fromIndex: 11, toIndex: 12, into: "style_images" }],
      ) },
    ],
  }],
  "ref-missing": [{
    meets: group([WORDS, { ...STORY }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'in the shot where the words speak of it', proposal: group([WORDS, { ...STORY, shots: [{ prompt: [{ text: "A paper boat. " }, { ref: 0 }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "notes-missing": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'Give each one a note in the prompt', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "shot-empty": [{
    meets: group([{ ...STORY, shots: [{ prompt: [], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    followed: [{ says: 'Every shot needs its own words', proposal: group([STORY]) }],
  }],
  "too-many-shots": [{
    meets: group([{ ...STORY, params: { duration: 7 }, shots: Array.from({ length: 7 }, (_, i) => ({ prompt: [{ text: `Shot ${String(i)}.` }], duration: 1 })) }]),
    followed: [{ says: 'Send at most 6, with their seconds still adding up to duration', proposal: group([{ ...STORY, params: { duration: 7 }, shots: Array.from({ length: 6 }, (_, i) => ({ prompt: [{ text: `Shot ${String(i)}.` }], duration: i === 0 ? 2 : 1 })) }]) }],
  }],
  "shot-too-long": [{
    meets: group([{ ...STORY, shots: [{ prompt: [{ text: LONG_SCRIPT }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }]),
    followed: [{ says: 'Shorten it', proposal: group([STORY]) }],
  }],
  "shots-duration": [{
    meets: group([{ ...STORY, params: { duration: 8 } }]),
    followed: [{ says: 'Make them match', proposal: group([STORY]) }],
  }],
  "prompt-missing": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [] })]),
    followed: [{ says: 'writes nothing in it', proposal: group([DRAW]) }],
  }],
  "lyrics-missing": [{
    meets: group([gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })]),
    followed: [{ says: 'A written text node goes into "Gen" by an edge with into: "lyrics"', proposal: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]) }],
  }],
  "prompt-too-long": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "y".repeat(2100) }] })]),
    followed: [{ says: 'Shorten it', proposal: group([gen("audio", "tts", TTS, { prompt: [{ text: "y".repeat(1900) }] })]) }, { says: 'or propose a model that takes it', proposal: group([gen("audio", "tts", LONG_TTS, { prompt: [{ text: "y".repeat(2100) }] })]) }],
  }],
  "script-too-long-for-shot": [{
    meets: group([{ ...WORDS, prompt: [{ text: LONG_SCRIPT }] }, { ...STORY, shots: [{ prompt: [{ ref: 0 }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'Shorten it', proposal: group([WORDS, { ...STORY, shots: [{ prompt: [{ ref: 0 }], duration: 2 }, TWO_SHOTS[1] as (typeof TWO_SHOTS)[number]] }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }, { says: 'or propose a model that takes it', proposal: group([{ ...WORDS, prompt: [{ text: LONG_SCRIPT }] }, gen("video", "t2v", SHOTS, { prompt: [{ text: "Film " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "written-takes-no-mark": [{
    meets: group([{ ...WORDS, prompt: [{ text: "Copy " }, NOTE] }, DRAW]),
    followed: [{ says: 'Take it out', proposal: group([WORDS, DRAW]) }],
  }],
  "material-not-source": [{
    meets: group([{ ...DRAW, material: PIC }]),
    followed: [{ says: 'only a source image, video or audio node holds', proposal: group([DRAW]) }],
  }],
  "material-not-ours": [{
    meets: group([{ ...HELD_PIC, material: ELSEWHERE }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [{ says: 'Save a picture found on the web with save_image first', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "material-missing": [{
    meets: group([{ ...HELD_PIC, material: MISSING }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [{ says: 'Copy it again exactly', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "material-wrong-kind": [{
    meets: group([{ ...HELD_PIC, material: CLIP }, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [{ says: 'Give it image material', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "text-source": [{
    meets: group([{ role: "source", type: "text", name: "Copy" }, DRAW]),
    followed: [{ says: 'send it as a written node', proposal: group([WORDS, DRAW]) }, { says: 'or leave it out', proposal: group([DRAW]) }],
  }],
  "source-configured": [{
    meets: group([{ ...EMPTY_PIC, mode: "t2i" }, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'takes no mode', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "written-not-text": [{
    meets: group([{ ...WORDS, type: "image" }, DRAW]),
    followed: [{ says: 'a text node is the only one', proposal: group([WORDS, DRAW]) }],
  }],
  "written-configured": [{
    meets: group([{ ...WORDS, mode: "t2i" }, DRAW]),
    followed: [{ says: 'takes no mode', proposal: group([WORDS, DRAW]) }],
  }],
  "written-empty": [{
    meets: group([{ ...WORDS, prompt: [{ text: "   " }] }, DRAW]),
    followed: [{ says: 'carries no words', proposal: group([WORDS, DRAW]) }],
  }],
  "mark-typed": [{
    meets: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make it {✏️ mood}." }] })]),
    followed: [{ says: 'Send each as a segment of its own', proposal: group([gen("image", "t2i", T2I, { prompt: [{ text: "Make it " }, { slot: { kind: "tweak", label: "mood", note: "mood" } }, { text: "." }] })]) }],
  }],
  "param-undeclared": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [
      { says: 'Leave "format" out', proposal: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      ...Object.entries(ANGLES_SETTABLE).map(([key, value]) => ({ says: `The ones set here: ${Object.keys(ANGLES_SETTABLE).join(", ")}.`, proposal: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { [key]: value } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) })),
    ],
  }],
  "param-from-list": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { voice_id: "Dennis" } })]),
    followed: [{ says: 'Leave it out and add a note saying which one to pick', proposal: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }, { slot: { kind: "note", label: "Pick a voice" } }] })]) }],
  }],
  "param-box": [{
    meets: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }], params: { lyrics: "la la" } })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]),
    followed: [{ says: 'Leave it out. A written text node goes into "Gen" by an edge with into: "lyrics"', proposal: group([WORDS, gen("audio", "t2m", SONG, { prompt: [{ text: "Upbeat pop." }] })], [{ fromIndex: 0, toIndex: 1, into: "lyrics" }]) }],
  }],
  "param-pool": [{
    meets: group([gen("image", "i2i", EDIT, { params: { images: PIC } })]),
    followed: [
      { says: 'Leave it out. An image node holding material goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      { says: 'An empty image node goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note saying what to do first', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
    ],
  }],
  "param-slot": [{
    meets: group([gen("image", "i2i", EDIT, { params: { style_images: PIC } })]),
    followed: [
      { says: 'Leave it out. An image node holding material goes into "Gen" through fills "style_images" on "Gen"', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) },
      { says: 'An empty image node goes into "Gen" by an edge with into: "style_images" and a note saying to pick it there and no ref', proposal: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit it." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]) },
    ],
  }],
  "param-storyboard": [{
    meets: group([{ ...STORY, params: { duration: 5, multi_prompt: "x" } }]),
    followed: [{ says: 'Leave it out of params and give shots', proposal: group([STORY]) }],
  }],
  "param-storyboard-other-mode": [{
    meets: group([gen("video", "t2v", SHOTS, { params: { multi_prompt: "x" } })]),
    followed: [{ says: "only the multi_shot mode takes. Leave it out", proposal: group([gen("video", "t2v", SHOTS)]) }],
  }],
  "param-no-control": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { output_format: "png" } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'Leave it out', proposal: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "param-gated-off": [{
    meets: group([gen("image", "t2i", T2I, { params: { camera: "ARRI Alexa 35" } })]),
    followed: [{ says: 'Set that switch', proposal: group([gen("image", "t2i", T2I, { params: { enable_camera: true, camera: "ARRI Alexa 35" } })]) }, { says: 'or leave "camera" out', proposal: group([DRAW]) }],
  }],
  "param-option": [{
    meets: group([gen("image", "t2i", T2I, { params: { aspect_ratio: "7:7" } })]),
    followed: [{ says: 'offers "1:1"', proposal: group([gen("image", "t2i", T2I, { params: { aspect_ratio: "1:1" } })]) }],
  }],
  "param-not-number": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }, { slot: { kind: "note", label: "Pick a voice" } }], params: { speed: "fast" } })]),
    followed: [{ says: 'takes a number', proposal: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }, { slot: { kind: "note", label: "Pick a voice" } }], params: { speed: 1.2 } })]) }],
  }],
  "param-out-of-range": [{
    meets: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { speed: 9 } })]),
    followed: [{ says: 'runs from 0.5 to 1.5', proposal: group([gen("audio", "tts", TTS, { prompt: [{ text: "Hello." }], params: { speed: 1.5 } })]) }],
  }],
  "param-off-step": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { horizontal_angle: 50 } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [{ says: 'so it takes 0, 45', proposal: group([EMPTY_PIC, gen("image", "i2i", ANGLES, { prompt: [{ text: "Turn " }, { ref: 0 }, NOTE], params: { horizontal_angle: 45 } })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }],
  }],
  "edge-kind-not-taken": [{
    meets: group([HELD_PIC, DRAW, { ...gen("image", "i2i", EDIT), name: "Edit" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [
      { says: 'Take that edge off. Send it into a generation that takes it: "Pic" goes into "Edit" by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "Edit", prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 2, into: "pool" }]) },
      { says: 'or through fills "style_images" on "Edit"', proposal: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "Edit", fills: { style_images: [0] } })]) },
    ],
  }, {
    meets: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "Edit", prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 2, into: "pool" }]),
    followed: [{ says: "goes nowhere in it. Take that edge off.", proposal: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "Edit", prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 2, into: "pool" }]) }],
  }, {
    meets: group([EMPTY_PIC, DRAW], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [
      { says: 'Take that edge off. No generation here has a way left for an image node; take "Pic" out', proposal: group([DRAW]) },
      { says: "or propose a model that takes it", proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
    ],
  }, {
    meets: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "E1", prompt: [{ text: "Edit " }, { ref: 0 }] }), gen("image", "i2i", EDIT, { name: "E2" })], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 2, into: "pool" }]),
    followed: [{ says: "goes nowhere in it. Take that edge off.", proposal: group([HELD_PIC, DRAW, gen("image", "i2i", EDIT, { name: "E1", prompt: [{ text: "Edit " }, { ref: 0 }] }), gen("image", "i2i", EDIT, { name: "E2" })], [{ fromIndex: 0, toIndex: 2, into: "pool" }]) }],
    endsOn: "goes nowhere in it. Take that edge off.",
  }, {
    meets: group([HELD_PIC, { ...DRAW, name: "D1" }, { ...DRAW, name: "D2" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }, { fromIndex: 0, toIndex: 2 }]),
    followed: [{ says: 'Take that edge off. No generation here has a way left for an image node; take "Pic" out', proposal: group([{ ...DRAW, name: "D1" }, { ...DRAW, name: "D2" }]) }],
  }],
  "edge-kind-not-taken-link": [{
    meets: group([{ ...DRAW, name: "A" }, { ...DRAW, name: "B" }], [{ fromIndex: 0, toIndex: 1, into: "pool" }]),
    followed: [
      { says: "Leave into off that edge", proposal: group([{ ...DRAW, name: "A" }, { ...DRAW, name: "B" }], [{ fromIndex: 0, toIndex: 1 }]) },
      { says: "or propose a model that takes it", proposal: group([{ ...DRAW, name: "A" }, gen("image", "i2i", EDIT, { name: "B", prompt: [{ text: "Edit " }, { ref: 0 }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
    ],
  }],
  "edge-into-ambiguous": [{
    meets: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1 }]),
    followed: [{ says: 'by an edge with into: "pool" and a ref @\'ing it and a note', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }, { says: 'by an edge with into: "style_images" and a note saying to pick it there and no ref', proposal: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit it." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]) }],
  }],
  "edge-not-an-entry": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT)], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]),
    followed: [{ says: 'by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) }, { says: 'through fills "style_images" on "Gen", with no edge and no ref', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }, {
    meets: group([HELD_PIC, gen("video", "i2v", VID, { name: "Vid", fills: { image: [0] }, prompt: [{ text: "Move it." }] }), { ...HELD_PIC, name: "B", material: CLIP_IMAGE }], [{ fromIndex: 2, toIndex: 1, into: "image" }]),
    followed: [
      { says: '"Vid" has no room left for another image node, so "B" has no way into it. No generation here has a way left for an image node; take "B" out', proposal: group([HELD_PIC, gen("video", "i2v", VID, { name: "Vid", fills: { image: [0] }, prompt: [{ text: "Move it." }] })]) },
      { says: "or propose a model that takes it", proposal: group([HELD_PIC, gen("video", "i2v", VID, { name: "Vid", fills: { image: [0] }, prompt: [{ text: "Move it." }] }), { ...HELD_PIC, name: "B", material: CLIP_IMAGE }, gen("image", "i2i", EDIT, { name: "Edit", fills: { style_images: [2] } })]) },
    ],
  }],
  "fill-outside": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [5] } })]),
    followed: [{ says: 'which is not in the group', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "fill-self": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [1] } })]),
    followed: [{ says: 'Check the index the fill means', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "fill-not-a-slot": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { nope: [0] } })]),
    followed: [
      { says: 'Take fills "nope" off. "Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      { says: 'or through fills "style_images" on "Gen"', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) },
    ],
  }],
  "fill-into-pool": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { images: [0] } })]),
    followed: [
      { says: 'Take fills "images" off. "Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit " }, { ref: 0 }] })], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      { says: 'or through fills "style_images" on "Gen"', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) },
    ],
  }],
  "fill-no-material": [{
    meets: group([EMPTY_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [
      { says: 'Take "Pic" out of fills "style_images". "Pic" goes into "Gen" by an edge with into: "pool" and a ref @\'ing it and a note', proposal: group([EMPTY_PIC, EDIT_POOL], [{ fromIndex: 0, toIndex: 1, into: "pool" }]) },
      { says: 'by an edge with into: "style_images" and a note saying to pick it there and no ref', proposal: group([EMPTY_PIC, gen("image", "i2i", EDIT, { prompt: [{ text: "Edit it." }, NOTE] })], [{ fromIndex: 0, toIndex: 1, into: "style_images" }]) },
    ],
  }],
  "fill-wrong-kind": [{
    meets: group([CLIP_HELD, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]),
    followed: [
      { says: 'Take "Clip" out of fills "style_images". "nano-banana-pro-edit-ultra" takes no video node, so "Clip" has no way into "Gen". No generation here has a way left for a video node; take "Clip" out', proposal: group([gen("image", "i2i", EDIT)]) },
      { says: "or propose a model that takes it", proposal: group([CLIP_HELD, gen("audio", "a2m", SCORE, { prompt: [{ text: "Score it." }], fills: { video: [0] } })]) },
    ],
  }],
  "fill-repeated": [{
    meets: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0, 0] } })]),
    followed: [{ says: "Name it once", proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
  "fill-twice": [{
    meets: group([HELD_PIC, { ...HELD_PIC, name: "Pic 2" }, gen("image", "i2i", EDIT, { fills: { style_images: [0, 1] } })]),
    followed: [{ says: 'Take "Pic 2" out', proposal: group([HELD_PIC, gen("image", "i2i", EDIT, { fills: { style_images: [0] } })]) }],
  }],
};

describe("every refusal's advice is a proposal the check takes", () => {
  for (const [refusal, cases] of Object.entries(CASES) as [RefusalId, RefusalCase[]][]) {
    for (const [at, entry] of cases.entries()) {
      it(`${refusal} (${String(at)}): is met, and each way it says to put it right is accepted`, () => {
        entry.catalog?.();
        const met = verdictFor(entry.meets, MATERIALS);
        expect(met).toMatchObject({ ok: false, refusal });
        const reason = met.ok ? "" : met.reason;
        // The words are pinned so a changed reason is seen in review beside
        // the advice followed below.
        expect(reason).toMatchSnapshot();
        if (entry.inTheReply !== undefined) expect(reason).toContain(entry.inTheReply);
        if (entry.endsOn !== undefined) expect(reason.endsWith(entry.endsOn), `"${reason}" ends on "${entry.endsOn}"`).toBe(true);
        for (const [i, { says, proposal }] of entry.followed.entries()) {
          if (says !== undefined) expect(reason, `the reason gives advice ${String(i)}`).toContain(says);
          expect(verdictFor(proposal, MATERIALS), `advice ${String(i)} of "${reason}"`).toEqual({ ok: true });
        }
        expect(entry.followed.length > 0 || entry.inTheReply !== undefined).toBe(true);
      });
    }
  }
});
