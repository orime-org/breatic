// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The checks one proposed node answers on its own: the material it names,
 * whether it is what its role says, and whether it types a mark as words.
 */
import { marksTypedIn, promptPlainText, type PromptSegment, type ProposalNode } from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { fixOn, refAsSent, refuse, type NodeLabel } from "@domain/agent/tools/proposal-refusals.js";
import { aNode, capitalised } from "@domain/agent/tools/proposal-routing.js";
import { SAVE_IMAGE } from "@domain/agent/tools/tool-names.js";
import type { MaterialTable } from "@domain/asset/material-facts.js";

/** The fields that configure a generation, named as the agent sends them. */
const CONFIGURED = ["mode", "model", "params", "fills", "shots"] as const;

/** Field names joined for a sentence, the last after "or". */
const ONE_OF = new Intl.ListFormat("en", { type: "disjunction" });

/** The node kinds that hold material. */
const MATERIAL_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/**
 * Each ref and note a written node carries, said by value: its ref segments,
 * its note segments, then each ref or note mark typed into its words, quoted
 * as written.
 *
 * A typed ✏️ mark is left out: a text node's words take one, as a segment of
 * its own.
 * @param node - The written node.
 * @returns What it carries.
 * @throws {never} Never.
 */
function carriedMarks(node: ProposalNode): string[] {
  const segments = (node.prompt ?? []).flatMap((segment) =>
    segment.ref !== undefined ? [refAsSent(segment.ref)] : segment.slot?.kind === "note" ? [`the note "${segment.slot.label}"`] : [],
  );
  const typed = typedMarks(node).filter(({ slot }) => slot.kind !== "tweak").map(({ written }) => `the typed "${written}"`);
  return [...segments, ...typed];
}

/**
 * Whether the material a node names is this studio's, and of the node's kind.
 *
 * An address in our storage with no live registration in this studio is
 * most likely mistyped, and is told to be copied again.
 * @param node - The node being judged.
 * @param at - The node, as a fix names it.
 * @param materials - The registration behind each address.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
export function checkMaterial(node: ProposalNode, at: NodeLabel, materials: MaterialTable): ProposalVerdict {
  if (node.material === undefined) return { ok: true };
  if (node.role !== "source" || !MATERIAL_KINDS.has(node.type)) {
    return refuse("material-not-source", `"${node.name}" carries material, which only a source image, video or audio node holds.`);
  }
  const facts = materials.get(node.material);
  if (facts === undefined) {
    // Only a picture can be saved from the web; a clip or a track reaches our
    // storage as a file the reader uploads in the chat.
    return node.type === "image"
      ? refuse("material-not-ours", `"${node.name}" holds an address that is not in our storage.`, fixOn(at, `save a picture found on the web with ${SAVE_IMAGE} first and use the address it answers with.`))
      : refuse("material-not-ours-media", `"${node.name}" holds an address that is not in our storage. ${capitalised(aNode(node.type))} takes material only from our storage: a file the user uploaded in the chat.`);
  }
  if (facts === "missing") {
    return refuse("material-missing", `"${node.name}" holds an address in our storage that does not exist, most likely mistyped.`, fixOn(at, `copy it again exactly as the attachment or the ${SAVE_IMAGE} answer gives it.`));
  }
  if (facts.kind !== node.type) {
    return refuse("material-wrong-kind", `"${node.name}" is ${aNode(node.type)} and its material is ${facts.kind}.`);
  }
  return { ok: true };
}

/**
 * Whether one node is the thing its role says it is.
 *
 * The three roles differ in what they carry, not only in what they are called:
 * an empty node holds nothing, a written one holds finished words and so can
 * only be a text node, and a generation is configured. A node whose role and
 * contents disagree lands on the canvas as something the reader cannot use.
 * @param node - The node being judged.
 * @param at - The node, as a fix names it.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
export function checkNodeRole(node: ProposalNode, at: NodeLabel): ProposalVerdict {
  const configured: string[] = CONFIGURED.filter((field) => node[field] !== undefined);
  if (node.role === "source") {
    // Words are the one kind of material nobody has to go and find: an empty
    // text node is a click away, so proposing one asks for work rather than
    // saving any. Write the words instead, as a written node.
    if (node.type === "text") {
      return refuse("text-source", `"${node.name}" is an empty text node, which the reader makes in one click; words go on a written node.`);
    }
    const carried = [...configured, ...(node.prompt !== undefined ? ["prompt"] : [])];
    if (carried.length > 0) {
      return refuse("source-configured", `"${node.name}" is a source node: it holds material or stands empty for the reader, so it takes no ${ONE_OF.format([...CONFIGURED, "prompt"])}; it carries ${carried.join(", ")}.`);
    }
    return { ok: true };
  }
  if (node.role !== "written") return { ok: true };

  if (node.type !== "text") {
    return refuse("written-not-text", `"${node.name}" carries words, and a text node is the only one that holds those.`);
  }
  if (configured.length > 0) {
    return refuse("written-configured", `"${node.name}" already holds its words, so it takes no ${ONE_OF.format(CONFIGURED)} -- nothing is generated there; it carries ${configured.join(", ")}.`);
  }
  // A text node's body holds words and nothing else: a reference would ask
  // for material nothing here reads, and a note would vanish from words that
  // are kept as written. Whatever they say belongs in the message this
  // proposal travels with.
  const marks = carriedMarks(node);
  if (marks.length > 0) {
    return refuse("written-takes-no-mark", `"${node.name}" holds words the reader keeps as they are, so it takes no ref or note; it carries ${marks.join(", ")}.`, fixOn(at, "take out every ref and note it carries, the typed ones included, and say what you meant in your own message."));
  }
  // Without them it lands as an empty text node, which is the thing a reader
  // makes in a click and has no use for in a proposal.
  if (promptPlainText(node.prompt ?? []).trim() === "") {
    return refuse("written-empty", `"${node.name}" says it holds words and carries no words.`);
  }
  return { ok: true };
}

/** The first character standing in for a segment that is not text, while a prompt is read as one string. */
const SEGMENT_MARK = 0xe000;

/** A mark typed into a node's words: what it reads as, and the words as the agent wrote them. */
interface TypedMark {
  slot: NonNullable<PromptSegment["slot"]>;
  written: string;
}

/**
 * A segment that is not text, as the agent sends it.
 * @param segment - The segment.
 * @returns Its JSON.
 * @throws {never} Never.
 */
function segmentAsSent(segment: PromptSegment): string {
  return segment.ref !== undefined ? refAsSent(segment.ref) : JSON.stringify({ slot: segment.slot });
}

/**
 * The marks a node's words carry typed out as text, read from its prompt and
 * every shot.
 *
 * Each prompt is read as one string, so a mark typed across two text segments
 * is caught too. Every other segment stands in as a character of its own:
 * brackets typed around it read back as one mark that swallows it, and the
 * mark is quoted with that segment written back as it was sent.
 * @param node - The node.
 * @returns The typed marks.
 * @throws {never} Never.
 */
export function typedMarks(node: ProposalNode): TypedMark[] {
  return [node.prompt ?? [], ...(node.shots ?? []).map((shot) => shot.prompt)].flatMap((segments) => {
    const words = segments.map((segment, i) => segment.text ?? String.fromCodePoint(SEGMENT_MARK + i)).join("");
    return marksTypedIn(words).map(({ slot, text }): TypedMark => ({
      slot,
      written: [...text].map((char) => {
        const segment = segments[(char.codePointAt(0) ?? 0) - SEGMENT_MARK];
        return segment !== undefined && segment.text === undefined ? segmentAsSent(segment) : char;
      }).join(""),
    }));
  });
}

/** The segment each kind of mark is sent as, for the rule a typed mark breaks. */
const SEGMENT_FORMS: Record<NonNullable<PromptSegment["slot"]>["kind"], string> = {
  asset: '{"ref": <index>} for a node',
  note: '{"slot": {"kind": "note", "label": "…"}} for a note',
  tweak: '{"slot": {"kind": "tweak", "label": "…", "note": "…"}} for words the reader writes',
};

/**
 * Whether a node's words carry a mark typed out as text.
 *
 * Typed, the bracket is words: the reader gets no line on the card for it,
 * the canvas adds nothing to it, and it reaches the model as it stands.
 * @param node - The node being judged.
 * @returns Whether it stands, and the marks typed with the rule they break when not.
 * @throws {never} Never.
 */
export function markTypedAsWords(node: ProposalNode): ProposalVerdict {
  const typed = typedMarks(node);
  if (typed.length === 0) return { ok: true };
  const forms = [...new Set(typed.map(({ slot }) => SEGMENT_FORMS[slot.kind]))];
  return refuse("mark-typed", `"${node.name}" types ${String(typed.length)} mark(s) into its words as text: ${typed.map(({ written }) => `"${written}"`).join(", ")}. A mark works only as a segment of its own, with the text segments kept to plain words: ${forms.join("; ")}.`);
}
