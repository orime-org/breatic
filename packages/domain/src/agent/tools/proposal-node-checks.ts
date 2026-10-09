// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The checks one proposed node answers on its own: the material it names,
 * whether it is what its role says, and whether it types a mark as words.
 */
import { markedSegments, promptPlainText, type ProposalNode } from "@breatic/shared";

import type { ProposalVerdict } from "@domain/agent/tools/proposal-input.js";
import { SAVE_IMAGE } from "@domain/agent/tools/tool-names.js";
import type { MaterialTable } from "@domain/asset/material-facts.js";

/** The node kinds that hold material. */
const MATERIAL_KINDS: ReadonlySet<string> = new Set(["image", "video", "audio"]);

/**
 * The refusal for a reference or note on a written node.
 *
 * A text node's body holds words and nothing else: a reference would ask for
 * material nothing here reads, and a note would vanish from words that are
 * kept as written. Said one way wherever it is caught, so a node is never
 * told to send the very segment the next check refuses.
 * @param node - The written node.
 * @returns The refusal.
 * @throws {never} Never.
 */
function writtenTakesNoMark(node: ProposalNode): ProposalVerdict {
  return {
    ok: false,
    reason: `"${node.name}" holds words the reader keeps as they are, so it takes no ref or note. Take it out and say what you meant in your own message.`,
  };
}

/**
 * Whether the material a node names is this studio's, and of the node's kind.
 *
 * An address the registration table does not hold is either somewhere else on
 * the web or not this studio's; both are put right the same way, by saving
 * the picture first.
 * @param node - The node being judged.
 * @param materials - The registration behind each address.
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
export function checkMaterial(node: ProposalNode, materials: MaterialTable): ProposalVerdict {
  if (node.material === undefined) return { ok: true };
  if (node.role !== "source" || !MATERIAL_KINDS.has(node.type)) {
    return {
      ok: false,
      reason: `"${node.name}" carries material, which only a source image, video or audio node holds.`,
    };
  }
  const facts = materials.get(node.material);
  if (facts === undefined) {
    return {
      ok: false,
      reason: `"${node.name}" holds an address that is not in our storage. Save a picture found on the web with ${SAVE_IMAGE} first and use the address it answers with.`,
    };
  }
  if (facts === "missing") {
    return {
      ok: false,
      reason: `"${node.name}" holds an address in our storage that does not exist, most likely mistyped. Copy it again exactly as the attachment or the ${SAVE_IMAGE} answer gives it.`,
    };
  }
  if (facts.kind !== node.type) {
    return { ok: false, reason: `"${node.name}" is a ${node.type} node and its material is ${facts.kind}.` };
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
 * @returns Whether it stands, and what is wrong with it when it does not.
 * @throws {never} Never.
 */
export function checkNodeRole(node: ProposalNode): ProposalVerdict {
  const configured =
    node.mode !== undefined ||
    node.model !== undefined ||
    node.params !== undefined ||
    node.fills !== undefined ||
    node.shots !== undefined;
  if (node.role === "source") {
    // Words are the one kind of material nobody has to go and find: an empty
    // text node is a click away, so proposing one asks for work rather than
    // saving any. Write the words instead, as a written node.
    if (node.type === "text") {
      return {
        ok: false,
        reason: `"${node.name}" is an empty text node, which the reader makes in one click. Write the words yourself and send it as a written node, or leave it out.`,
      };
    }
    if (configured || node.prompt !== undefined) {
      return {
        ok: false,
        reason: `"${node.name}" is a source node: it holds material or stands empty for the reader, so it takes no mode, model, parameters, fills, shots or prompt.`,
      };
    }
    return { ok: true };
  }
  if (node.role !== "written") return { ok: true };

  if (node.type !== "text") {
    return {
      ok: false,
      reason: `"${node.name}" carries words, and a text node is the only one that holds those.`,
    };
  }
  if (configured) {
    return {
      ok: false,
      reason: `"${node.name}" already holds its words, so it takes no mode, model, fills or shots -- nothing is generated there.`,
    };
  }
  // A text node's body holds words and nothing else: a reference would ask
  // for material nothing here reads, and a note would vanish from words that
  // are kept as written. Whatever they say belongs in the message this
  // proposal travels with.
  const reaching = (node.prompt ?? []).find(
    (segment) => segment.ref !== undefined || segment.slot?.kind === "note",
  );
  if (reaching) return writtenTakesNoMark(node);
  // Without them it lands as an empty text node, which is the thing a reader
  // makes in a click and has no use for in a proposal.
  if (promptPlainText(node.prompt ?? []).trim() === "") {
    return { ok: false, reason: `"${node.name}" says it holds words and carries no words.` };
  }
  return { ok: true };
}

/**
 * Whether a node's words carry a mark typed out as text.
 *
 * Typed, the bracket is words: the reader gets no line on the card for it,
 * the canvas adds nothing to it, and it reaches the model as it stands.
 * @param node - The node being judged.
 * @returns Whether it stands, and the segment to send in its place when not.
 * @throws {never} Never.
 */
export function markTypedAsWords(node: ProposalNode): ProposalVerdict {
  // Each prompt is read as one string, so a mark typed across two text
  // segments is caught too. A slot stands in as one character: brackets typed
  // around a mark read back as one mark that swallows it, as they would once
  // written out.
  const typed = [node.prompt ?? [], ...(node.shots ?? []).map((shot) => shot.prompt)].flatMap((segments) =>
    markedSegments(segments.map((segment) => segment.text ?? "\u0000").join("")).flatMap((part) => (part.slot ? [part.slot] : [])),
  );
  if (typed.length === 0) return { ok: true };
  if (node.role === "written" && typed.some((slot) => slot.kind !== "tweak")) return writtenTakesNoMark(node);
  return {
    ok: false,
    reason: `"${node.name}" types ${String(typed.length)} mark(s) into its words. Send each as a segment of its own and keep the text segments to plain words: ${typed.map((slot) => (slot.kind === "asset" ? `{"ref": <index of the node meant by ${slot.label}>}` : JSON.stringify({ slot }))).join(", ")}.`,
  };
}
