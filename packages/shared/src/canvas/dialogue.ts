// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A param that stands in for another (#2156), and the dialogue it carries
 * (inner#1825 design 8.5).
 *
 * Gemini reads its script either in one voice or as a dialogue between named
 * speakers, and ignores the voice once speakers are given. Its yaml says so
 * with `replaces` on `speakers`; the panel offers the two as a switch, and
 * only the side the user is on goes to the upstream.
 *
 * Which side that is lives in the model's own param record under
 * {@link STAND_IN_ON}, so leaving the dialogue keeps the speakers the user
 * wrote. On the dialogue side the script is one line per turn, each line
 * naming its speaker by number; {@link dialogueText} writes it out as the
 * `Name: line` script the upstream reads. The landing writers switch the
 * side on through {@link withStandInOn}; the panel reads it through
 * {@link dialogueSideOf}, and the agent's checks read a record not yet landed
 * through both.
 */

import { completeEntries } from "@shared/item-cap.js";

/**
 * The record key holding whether the stand-in is the side in use.
 *
 * Not a catalog param: the panel takes it off before anything leaves the
 * browser, and the reconciler keeps it only on a model that has a stand-in.
 */
export const STAND_IN_ON = "_stand_in_on";

/**
 * What these helpers read of a model: its params' stand-in declarations. Any
 * catalog entry fits, the web wire entry and the backend's alike.
 */
export interface StandInModel {
  readonly params: Readonly<Record<string, object>>;
}

/** The fields one entry of an `items` param declares. */
type EntryFields = Readonly<Record<string, { readonly values?: readonly unknown[] }>>;

/** The stand-in a model declares. */
export interface StandIn {
  /** The param that stands in, e.g. `speakers`. */
  readonly name: string;
  /** The param it replaces, e.g. `voice_id`. */
  readonly replaces: string;
  /** The fewest complete entries a run takes. */
  readonly min: number;
}

/** One line of a dialogue: its words and the number of its speaker, from 1. */
export interface DialogueLine {
  readonly speaker?: number | null;
  readonly text: string;
}

/**
 * The stand-in this model declares, if any.
 * @param model - The active model, or undefined before one resolves.
 * @returns The stand-in, or null when the model declares none.
 * @throws {never} Never.
 */
export function standInOf(model: StandInModel | undefined): StandIn | null {
  if (!model) return null;
  for (const [name, declared] of Object.entries(model.params)) {
    const spec = declared as { readonly replaces?: unknown; readonly min_items?: unknown };
    if (typeof spec.replaces === "string" && spec.replaces in model.params) {
      return { name, replaces: spec.replaces, min: typeof spec.min_items === "number" ? spec.min_items : 1 };
    }
  }
  return null;
}

/**
 * Whether the record has the stand-in side switched on.
 * @param params - The model's param record.
 * @returns True only for an explicit true.
 * @throws {never} Never.
 */
export function isStandInOn(params: Readonly<Record<string, unknown>>): boolean {
  return params[STAND_IN_ON] === true;
}

/**
 * How many entries of the stand-in param are complete.
 * @param model - The model.
 * @param standIn - Its stand-in.
 * @param params - Its param record.
 * @returns The count.
 * @throws {never} Never.
 */
function completeCount(model: StandInModel, standIn: StandIn, params: Readonly<Record<string, unknown>>): number {
  const fields = (model.params[standIn.name] as { readonly fields?: unknown } | undefined)?.fields;
  return completeEntries(params[standIn.name], typeof fields === "object" && fields !== null ? (fields as EntryFields) : {}).length;
}

/**
 * A record written from outside the panel (a template, an Agent proposal),
 * put on the stand-in side when it brings complete stand-in entries.
 *
 * Such a writer names the speakers because it wants the dialogue, and without
 * the switch the panel would drop them. A switch the record already holds is
 * the user's choice and stays.
 * @param model - The model the record belongs to, or undefined when unknown.
 * @param params - The record as the writer gives it.
 * @returns The record, switched to the stand-in side when it brings entries for it.
 * @throws {never} Never.
 */
export function withStandInOn(
  model: StandInModel | undefined,
  params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const standIn = standInOf(model);
  if (!model || !standIn || typeof params[STAND_IN_ON] === "boolean" || completeCount(model, standIn, params) === 0) return { ...params };
  return { ...params, [STAND_IN_ON]: true };
}

/**
 * Whether a record is on the dialogue side: the model declares a stand-in and
 * the switch is on. A stored record with no switch reads in one voice,
 * however complete its speakers; a writer's record not yet landed is read
 * through {@link withStandInOn} first (design 8.5).
 * @param model - The model, or undefined when unknown.
 * @param params - Its param record.
 * @returns Whether the lines are the words sent.
 * @throws {never} Never.
 */
export function dialogueSideOf(model: StandInModel | undefined, params: Readonly<Record<string, unknown>>): boolean {
  return standInOf(model) !== null && isStandInOn(params);
}

/**
 * Whether a dialogue holds fewer complete entries than the model takes.
 * @param model - The active model.
 * @param params - Its param record.
 * @returns True only on the stand-in side and below its floor.
 * @throws {never} Never.
 */
export function speakersShort(
  model: StandInModel | undefined,
  params: Readonly<Record<string, unknown>>,
): boolean {
  const standIn = standInOf(model);
  if (!model || !standIn || !isStandInOn(params)) return false;
  return completeCount(model, standIn, params) < standIn.min;
}

/**
 * The speakers a record names, in order, each by its name as written.
 * @param model - The model, or undefined when unknown.
 * @param params - Its param record.
 * @returns The speakers; none when the model has no stand-in or the record names none.
 * @throws {never} Never.
 */
export function dialogueSpeakers(model: StandInModel | undefined, params: Readonly<Record<string, unknown>>): { speaker: string }[] {
  const standIn = standInOf(model);
  const entries = standIn === null ? undefined : params[standIn.name];
  if (!Array.isArray(entries)) return [];
  return entries.map((entry: unknown) => {
    const name = typeof entry === "object" && entry !== null ? (entry as { speaker?: unknown }).speaker : undefined;
    return { speaker: typeof name === "string" ? name : "" };
  });
}

/**
 * Each line's speaker as it is read: its own when it names one of the
 * speakers, else the previous line's, the first such speaker 1.
 * @param lines - The lines.
 * @param count - How many speakers there are.
 * @returns One speaker number per line.
 * @throws {never} Never.
 */
export function lineSpeakers(lines: readonly DialogueLine[], count: number): number[] {
  let previous = 1;
  return lines.map((line) => {
    const own = line.speaker;
    if (typeof own === "number" && Number.isInteger(own) && own >= 1 && own <= count) previous = own;
    return previous;
  });
}

/** What a line becomes: its speaker, from 1, and how many leading characters to drop. */
export interface LinePlan {
  readonly speaker: number;
  readonly strip: number;
}

/**
 * The speaker a line's typed prefix names (a speaker's name, then a
 * half-width or full-width colon, then any spaces), and the prefix's length.
 * A blank name never matches; the longest name that matches wins.
 * @param text - The line's words.
 * @param names - The speakers' names, from speaker 1.
 * @returns The speaker and the prefix length, or null when the line starts with no name and colon.
 * @throws {never} Never.
 */
export function typedSpeaker(text: string, names: readonly string[]): LinePlan | null {
  let best: { speaker: number; strip: number; length: number } | null = null;
  for (const [at, raw] of names.entries()) {
    const name = raw.trim();
    if (name === "" || !text.startsWith(name) || (best !== null && best.length >= name.length)) continue;
    const colon = /^\s*[:\uFF1A]\s*/.exec(text.slice(name.length));
    if (colon) best = { speaker: at + 1, strip: name.length + colon[0].length, length: name.length };
  }
  return best === null ? null : { speaker: best.speaker, strip: best.strip };
}

/**
 * Each line's speaker and the prefix it drops (design 8.5): a typed name and
 * colon in front names the speaker and is taken off; a line with none keeps
 * its own speaker, else the previous line's, the first such speaker 1.
 * @param lines - The lines as they stand.
 * @param names - The speakers' names, from speaker 1.
 * @returns One plan per line; applying it and planning again strips nothing.
 * @throws {never} Never.
 */
export function planDialogueLines(lines: readonly DialogueLine[], names: readonly string[]): LinePlan[] {
  const typed = lines.map((line) => typedSpeaker(line.text, names));
  const speakers = lineSpeakers(
    lines.map((line, at) => ({ text: line.text, speaker: typed[at]?.speaker ?? line.speaker })),
    names.length,
  );
  return speakers.map((speaker, at) => ({ speaker, strip: typed[at]?.strip ?? 0 }));
}

/**
 * The script a dialogue sends: each line after its speaker's name and a
 * half-width colon, a line apart, the form the upstream reads speaker labels
 * in. A blank line is skipped and a line break inside a line reads as a space.
 * @param lines - The lines, each line's words already its sent text.
 * @param speakers - The speakers, numbered from 1.
 * @returns The script; the empty string when no line has words.
 * @throws {never} Never.
 */
export function dialogueText(lines: readonly DialogueLine[], speakers: readonly { readonly speaker: string }[]): string {
  // Read as the editor puts the lines right, so a node never opened since it
  // was written as `Name: line` sends the same script (design 8.5).
  const plans = planDialogueLines(lines, speakers.map((one) => one.speaker));
  return lines
    .flatMap((line, at) => {
      const text = line.text.slice(plans[at]?.strip ?? 0).replace(/\s*\n\s*/g, " ").trim();
      if (text === "") return [];
      const name = (speakers[(plans[at]?.speaker ?? 1) - 1]?.speaker ?? "").trim();
      return [`${name}: ${text}`];
    })
    .join("\n");
}
