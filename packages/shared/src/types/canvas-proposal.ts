// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The shape of a proposed group of canvas nodes (#229).
 *
 * The model sends one of these through the propose tool; the card in the chat
 * column draws it, and the canvas places it. Three readers, so the shape lives
 * here rather than in any one of them -- the check that decides whether a
 * proposal holds together stays on the backend, because only it can read the
 * model catalog.
 */

import { z } from "zod";

import { t, tInEveryLocale } from "@shared/i18n/index.js";
import { isGenerationNodeType, type GenerationNodeType } from "@shared/types/model-catalog.js";

/**
 * What a marked spot in the prompt asks of the reader (inner#977): `asset`
 * names something to @ by hand, `tweak` words to fill in, and `note` how to
 * operate the panel -- shown to the reader and never sent to the model.
 */
export type SlotKind = NonNullable<PromptSegment["slot"]>["kind"];

/**
 * One stretch of the prompt: plain words, a place the reader acts on, or an
 * @ of another node in the proposal by its index (inner#1315), which lands as
 * the same mention the reader would insert by hand.
 */
const promptSegmentSchema = z.union([
  z.object({ text: z.string(), slot: z.undefined().optional(), ref: z.undefined().optional() }),
  z.object({
    text: z.undefined().optional(),
    ref: z.undefined().optional(),
    slot: z.union([
      z.object({ kind: z.enum(["asset", "tweak"]), label: z.string(), note: z.string() }),
      z.object({ kind: z.literal("note"), label: z.string(), note: z.undefined().optional() }),
    ]),
  }),
  z.object({ ref: z.number().int().nonnegative(), text: z.undefined().optional(), slot: z.undefined().optional() }),
]);

/** One stretch of the prompt, as {@link promptSegmentSchema} describes it. */
export type PromptSegment = z.infer<typeof promptSegmentSchema>;

/** The brackets and symbol each kind wears where it is written as words. */
const MARK_FORM: Readonly<Record<SlotKind, { open: string; symbol: string; close: string }>> = {
  asset: { open: "[", symbol: "📎", close: "]" },
  tweak: { open: "{", symbol: "✏️", close: "}" },
  note: { open: "(", symbol: "💡", close: ")" },
};

/**
 * A mark as words: the bracket, symbol and label of its kind, the label of a
 * reference wrapped in the words asking the reader to @ it. A template's
 * locale prompt writes marks this way, and so does the prompt handed to the
 * agent; {@link markedSegments} reads them back.
 * @param slot - The spot the reader acts on.
 * @returns The bracketed text.
 * @throws {never} Never.
 */
export function writtenMark(slot: NonNullable<PromptSegment["slot"]>): string {
  const { open, symbol, close } = MARK_FORM[slot.kind];
  const words = slot.kind === "asset" ? t("canvas.promptMark.reference", { label: slot.label }) : slot.label;
  return `${open}${symbol} ${words}${close}`;
}

/**
 * What one marked spot puts in the prompt text.
 *
 * Written here because two sides need the same answer: the canvas writes this
 * into the box, and the check that decides whether a proposal holds together
 * counts it against the model's input cap. Spelled out twice, a proposal could
 * pass a count of one shape and land as another.
 *
 * A note puts nothing in the text: it lands as a block of its own that is
 * left out of what the model receives.
 * @param slot - The spot the reader acts on.
 * @returns The bracketed text, as the reader will see it.
 * @throws {never} Never.
 */
export function markText(slot: NonNullable<PromptSegment["slot"]>): string {
  return slot.kind === "note" ? "" : writtenMark(slot);
}

/**
 * Whether a mark written as words reads back as the same mark: a label
 * holding the bracket that closes its kind would read back cut short, and one
 * holding a line break is split across two paragraphs by the box.
 * @param slot - The spot the reader acts on.
 * @returns True when {@link markedSegments} gives the same kind and label back.
 * @throws {never} Never.
 */
export function markReadsBack(slot: NonNullable<PromptSegment["slot"]>): boolean {
  const [only, ...rest] = markedSegments(writtenMark(slot));
  return !slot.label.includes("\n") && rest.length === 0 && only?.slot?.kind === slot.kind && only.slot.label === slot.label;
}

/** The kinds in the order {@link MARK_PATTERN} lists them, one capture group each. */
const MARK_KINDS = Object.keys(MARK_FORM) as SlotKind[];

/**
 * A mark as a template's locale prompt writes it, its label captured in the
 * group of its kind: the symbol picks the kind, so brackets the reader types
 * stay words.
 */
const MARK_PATTERN = new RegExp(
  MARK_KINDS.map((kind) => {
    const { open, symbol, close } = MARK_FORM[kind];
    return `\\${open}${symbol} ([^\\${close}]+)\\${close}`;
  }).join("|"),
  "gu",
);

/**
 * A reference mark's label with the words {@link markText} asks the reader
 * with taken back off. Tried in every language, since the box may have been
 * filled in another one than the language reading it now.
 * @param label - What sits between `[📎 ` and `]`.
 * @returns The label alone.
 * @throws {never} Never.
 */
function bareReferenceLabel(label: string): string {
  for (const wording of tInEveryLocale("canvas.promptMark.reference", { label: "\u0000" })) {
    const [before = "", after = ""] = wording.split("\u0000");
    if (label.length > before.length + after.length && label.startsWith(before) && label.endsWith(after)) {
      return label.slice(before.length, label.length - after.length);
    }
  }
  return label;
}

/** The mark a slot segment stands for. */
type MarkSlot = NonNullable<PromptSegment["slot"]>;

/** A mark typed into words: the mark it stands for, how it is written there and where. */
export interface TypedMark {
  readonly slot: MarkSlot;
  readonly text: string;
  /** Where in the words the mark starts. */
  readonly at: number;
}

/**
 * The marks a stretch of words types out, each read once: the mark it stands
 * for, the label doubling as the card's line where the kind has one, and the
 * mark as it is written there.
 * @param text - The words.
 * @returns Each typed mark, in order.
 * @throws {never} Never.
 */
export function marksTypedIn(text: string): TypedMark[] {
  return [...text.matchAll(MARK_PATTERN)].map((match) => {
    const group = match.findIndex((captured, i) => i > 0 && captured !== undefined);
    const kind = MARK_KINDS[group - 1] ?? "tweak";
    const read = match[group] ?? "";
    const label = kind === "asset" ? bareReferenceLabel(read) : read;
    return { slot: kind === "note" ? { kind, label } : { kind, label, note: label }, text: match[0], at: match.index };
  });
}

/**
 * Read a prompt into segments: each `[📎 …]`, `{✏️ …}` and `(💡 …)` becomes
 * the mark it stands for. The inverse of {@link writtenMark}: a template's
 * locale prompt and a prompt copied out of a box read back to the same label.
 * @param text - The prompt as a locale file or a box writes it.
 * @returns Its segments.
 * @throws {never} Never.
 */
export function markedSegments(text: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let at = 0;
  for (const mark of marksTypedIn(text)) {
    if (mark.at > at) segments.push({ text: text.slice(at, mark.at) });
    segments.push({ slot: mark.slot });
    at = mark.at + mark.text.length;
  }
  if (at < text.length) segments.push({ text: text.slice(at) });
  return segments;
}

/**
 * The prompt as the panel will read it back, marks and all.
 *
 * Projected the way the canvas writes it and the editor gives it back: a line
 * break in a proposed stretch of text starts a new block, and the editor puts
 * two between blocks. Counted any other way, a proposal sits inside the
 * model's input cap here and past it by the time the reader presses Generate.
 * @param segments - The proposed prompt.
 * @param refWords - What an @ of the node at an index sends, as the panel
 *   serialises it.
 * @returns The text the panel will measure.
 * @throws {never} Never.
 */
export function promptTextOf(
  segments: readonly PromptSegment[],
  refWords: (ref: number) => string,
): string {
  return segments
    .map((s) => (s.slot ? markText(s.slot) : s.ref !== undefined ? refWords(s.ref) : s.text.replace(/\n/g, "\n\n")))
    .join("");
}

/**
 * The same words as they go into a text node's body.
 *
 * Apart from `promptTextOf` by one substitution, and it has to be: that one
 * answers "how much will the prompt box hold once the editor has been through
 * it", and an editor puts two line breaks between blocks. A text node's body
 * cuts its own blocks on single breaks, so doubling them there turns a note
 * with three breaks in it into six loose lines.
 *
 * The marks stay in the words either way -- a place the reader rewrites is
 * bracketed in the body exactly as it is in a prompt.
 * @param segments - The proposed words.
 * @returns The text to write into the body.
 * @throws {never} Never.
 */
export function promptPlainText(segments: readonly PromptSegment[]): string {
  return segments.map((s) => (s.slot ? markText(s.slot) : (s.text ?? ""))).join("");
}

/**
 * What a proposed node is, in the group the reader is about to place.
 *
 * `source` stands empty for them to drop material into, `generate` waits for
 * them to press Generate, and `written` already holds the words -- the only
 * one of the three whose content is finished before anything is placed.
 */
const proposalRoleSchema = z.enum(["source", "generate", "written"]);

/** What a proposed node is, as {@link proposalRoleSchema} lists it. */
export type ProposalRole = z.infer<typeof proposalRoleSchema>;

/** Every node kind a proposal can place: the three that generate, plus text. */
const proposalNodeTypeSchema = z.union([
  z.literal("text"),
  z.custom<GenerationNodeType>((value) => typeof value === "string" && isGenerationNodeType(value)),
]);

/** Every node kind a proposal can place, as {@link proposalNodeTypeSchema} lists it. */
export type ProposalNodeType = z.infer<typeof proposalNodeTypeSchema>;

/** The numbers a material's registration holds, as a node keeps them. */
const materialMediaSchema = z.object({
  coverUrl: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
});

/** One shot of a proposed multi-shot generation. */
const proposalShotSchema = z.object({
  prompt: z.array(promptSegmentSchema),
  duration: z.number(),
});

/** One shot, as {@link proposalShotSchema} describes it. */
export type ProposalShot = z.infer<typeof proposalShotSchema>;

/** One node of a proposal, before anything is placed. */
const proposalNodeSchema = z.object({
  role: proposalRoleSchema,
  type: proposalNodeTypeSchema,
  name: z.string(),
  /**
   * The reader's material a source node lands holding: an address in our
   * storage. A source node without it lands empty for the reader to fill.
   */
  material: z.string().optional(),
  /**
   * What the check read off the material's registration, so the node lands
   * with the numbers an upload would have given it. Written by the check,
   * never by the model.
   */
  materialMedia: materialMediaSchema.optional(),
  /**
   * The slots of a generation filled straight from material nodes: slot param
   * name to the indices of the source nodes that fill it. The slot takes a
   * snapshot of each, the way a pick in the panel does, and no edge is drawn.
   */
  fills: z.record(z.string(), z.array(z.number())).optional(),
  mode: z.string().optional(),
  model: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  prompt: z.array(promptSegmentSchema).optional(),
  /**
   * The shots of a multi-shot generation, each with its own prompt and whole
   * seconds; given in the `multi_shot` mode only, where they stand in for the
   * main prompt.
   */
  shots: z.array(proposalShotSchema).optional(),
  /**
   * Whether the panel will draw a prompt box here, answered by the check.
   *
   * Carried on the node because the catalog is the authority, the check has
   * just read it, and a reader can press Use before the catalog has loaded on
   * the canvas. A model drawing no box mounts no editor, so the canvas writes
   * nothing there and the card lists the marks instead. Absent on a node that
   * generates nothing.
   */
  takesPrompt: z.boolean().optional(),
  /**
   * The file we host that a template's resource node lands holding: a path
   * under the hosted-resources address. Filled from the template, never by
   * the model.
   */
  resource: z.string().optional(),
  /**
   * The template node this node stands for (inner#1345): its template and key,
   * and for the guide text node the index of the anchor it explains. Written
   * after the template check, never by the model.
   */
  templateNode: z
    .object({ template: z.string(), key: z.string(), anchor: z.number().int().nonnegative().optional() })
    .optional(),
});

/** One node, as {@link proposalNodeSchema} describes it. */
export type ProposalNode = z.infer<typeof proposalNodeSchema>;

/**
 * A whole proposal, as the model sends it and the card reads it.
 *
 * The one description of its shape: the types are read off it, and a proposal
 * read back from storage is checked against it (inner#1499), so one stored
 * before the shape changed is known for what it is rather than placed as if it
 * were current.
 */
export const canvasProposalSchema = z.object({
  nodes: z.array(proposalNodeSchema),
  /**
   * The wiring. `into` says where the node wired in goes on the generation it
   * feeds: `"pool"` for the reference pool, the name of one of its slots, or
   * `PANEL_EDITOR_PARAM` for a song model's lyrics box.
   */
  edges: z.array(z.object({ fromIndex: z.number(), toIndex: z.number(), into: z.string().optional() })),
  modelNote: z.string().optional(),
  rationale: z.string(),
  /**
   * What to call the group these nodes land in.
   *
   * Two or more nodes arrive inside a group, and only the model knows what
   * the group is for -- it just decided. One node places no group and needs
   * no name.
   */
  groupName: z.string().optional(),
});

/** A whole proposal, as {@link canvasProposalSchema} describes it. */
export type CanvasProposal = z.infer<typeof canvasProposalSchema>;

/**
 * Every segment of a node that can carry a mark: the main prompt, then each
 * shot in turn (#2218).
 * @param node - The proposed node.
 * @returns The segments, prompt first.
 * @throws {never} Never.
 */
export function proposalMarkSegments(node: ProposalNode): PromptSegment[] {
  return [...(node.prompt ?? []), ...(node.shots ?? []).flatMap((shot) => shot.prompt)];
}

/**
 * Every place one node of a proposal feeds another: its edges, then each fill.
 *
 * A material node that fills a slot is drawn with no edge, yet it is as much
 * part of the generation it fills as one wired in, so whatever arranges the
 * nodes or groups them reads both through here.
 * @param proposal - The proposal being read.
 * @returns One pair per edge and per filled index, edges first.
 * @throws {never} Never.
 */
export function feedsOf(proposal: CanvasProposal): Array<{ fromIndex: number; toIndex: number }> {
  const fills = proposal.nodes.flatMap((node, toIndex) =>
    Object.values(node.fills ?? {}).flatMap((indices) => indices.map((fromIndex) => ({ fromIndex, toIndex }))),
  );
  return [...proposal.edges.map(({ fromIndex, toIndex }) => ({ fromIndex, toIndex })), ...fills];
}

/**
 * How far downstream each node of a proposal sits, counting from what starts it.
 *
 * One further than the last thing that feeds it. Both the card's little
 * diagram and the arrangement on the canvas are drawn from this, so the depth
 * a node is at is one answer -- read twice, the two drift the first time
 * either is changed. What each does on top of it differs: the card splits its
 * chips into runs, and the canvas puts every node of one depth in one column.
 *
 * The walk is bounded by the node count rather than run to a fixed point: the
 * check refuses a ring before any of this is reached, so it settles long
 * before the bound, and a stored row that arrived some other way cannot spin.
 * @param proposal - The proposal being read.
 * @returns One depth per node, in the proposal's own order.
 * @throws {never} Never.
 */
export function layersOf(proposal: CanvasProposal): number[] {
  const depth = proposal.nodes.map(() => 0);
  const feeds = feedsOf(proposal);
  for (let pass = 0; pass < proposal.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of feeds) {
      const from = depth[edge.fromIndex];
      const to = depth[edge.toIndex];
      if (from === undefined || to === undefined || to > from) continue;
      depth[edge.toIndex] = from + 1;
      moved = true;
    }
    if (!moved) break;
  }
  return depth;
}

/** What a refused proposal answers with, so the model can send a better one. */
export interface ProposalRefused {
  placed: false;
  reason: string;
}

/** What the tool answers with: the proposal itself, or why it was refused. */
export type ProposalAnswer = (CanvasProposal & { placed: true }) | ProposalRefused;
