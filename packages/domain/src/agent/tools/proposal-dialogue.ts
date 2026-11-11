// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A proposed generation read as a dialogue (inner#1825 design 8.5): whether
 * it is on the dialogue side of a model whose speakers stand in for its
 * voice, the decision the panel and the landing make with the same shared
 * function, and the script its lines send.
 */
import { dialogueSideOf, dialogueSpeakers, dialogueText, STAND_IN_ON, withStandInOn, type ModelEntry, type PromptSegment, type ProposalNode } from "@breatic/shared";
import { catalogEntryOf } from "@breatic/shared/mini-tools";

import { getModelCatalog } from "@domain/model-catalog/model-catalog.js";

/**
 * The catalog entry of the model a node names.
 * @param node - The node.
 * @returns The entry, or undefined when it names none the catalog serves.
 * @throws {never} Never.
 */
export function proposalModelEntry(node: Pick<ProposalNode, "model">): ModelEntry | undefined {
  return node.model === undefined ? undefined : catalogEntryOf(getModelCatalog(), node.model);
}

/**
 * Whether a node's lines are the words it sends.
 * @param node - The node.
 * @returns True on the dialogue side of a model with a stand-in.
 * @throws {never} Never.
 */
export function onDialogueSide(node: Pick<ProposalNode, "model" | "params">): boolean {
  const params = node.params ?? {};
  // Only an explicit switch or a list of entries can put a record on the
  // dialogue side, so the catalog is read only for a record holding one.
  if (params[STAND_IN_ON] !== true && !Object.values(params).some(Array.isArray)) return false;
  // Not landed yet: read as the landing will write it.
  const entry = proposalModelEntry(node);
  return dialogueSideOf(entry, withStandInOn(entry, params));
}

/**
 * The speakers a node's params name, in order, each by its name as written.
 * @param node - The node.
 * @returns The speakers; none when the model has no stand-in or the params name none.
 * @throws {never} Never.
 */
export function proposalSpeakers(node: Pick<ProposalNode, "model" | "params">): { speaker: string }[] {
  return dialogueSpeakers(proposalModelEntry(node), node.params ?? {});
}

/**
 * The script a node's lines send: each line's words after its speaker's name.
 * @param node - The node.
 * @param words - How one line's segments read as sent text.
 * @returns The script; the empty string with no line written.
 * @throws {never} Never.
 */
export function proposalDialogueText(node: ProposalNode, words: (segments: readonly PromptSegment[]) => string): string {
  return dialogueText((node.lines ?? []).map((line) => ({ speaker: line.speaker, text: words(line.prompt) })), proposalSpeakers(node));
}
