// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A stored message as the record tools write it out (inner#1469).
 *
 * The words a user saw said are not all in a message's text parts: the
 * answers to a questionnaire live in the `ask_user` call's result, and a
 * proposal's prompts in the call's input. Reading a conversation back carries
 * those, and leaves out what was never shown as said -- the model's thinking
 * and the markers of how a turn ended. A record tool's call is written
 * without its result, which is a copy of records found elsewhere. Each part
 * is cut on its own: a text part at the page length, saying how much it
 * lost, and a tool's words at the tool length. The search
 * in the server matches only words this writes out: the text parts, the
 * attachments' names, a questionnaire's questions and the answers given (an
 * old single-question card's question and options; for an `ask_user` input
 * neither shape fits, every question, option and answer string it holds, as
 * the search reads them), and the strings of every
 * other tool's input, each cut to the same length as here.
 */

import { getAgentConfig } from "@breatic/core";
import { readQuestionnaire, type AskUserResult, type MessagePart } from "@breatic/shared";

import { clip } from "@domain/agent/tools/failure.js";
import { ASK_USER, RECORD_TOOL_NAMES } from "@domain/agent/tools/tool-names.js";

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/**
 * Every string a value holds, in order, however deep.
 * @param value - A tool's input or result.
 * @returns The strings.
 * @throws {never} Never.
 */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringsOf);
  return [];
}

/**
 * A tool's words, cut to the configured length.
 * @param value - Its input or result.
 * @returns The strings joined, with a leading space and ending with `…` where
 *   they were cut, or nothing when it holds none.
 * @throws {never} Never.
 */
function wordsOf(value: unknown): string {
  const words = stringsOf(value).join(" ");
  if (words === "") return "";
  const cut = clip(words, getAgentConfig().records_tool_text_max_chars);
  return ` ${cut}${cut === words ? "" : "…"}`;
}

/**
 * Whether a tool is one of the record tools, whose results copy records kept elsewhere.
 * @param name - The tool's name.
 * @returns True for a record tool.
 * @throws {never} Never.
 */
function isRecordTool(name: string): boolean {
  return (RECORD_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * A questionnaire: each question, and the answer given to it.
 * @param questions - The questions as they were asked.
 * @param output - What the call ended with, when it has ended.
 * @returns The lines.
 * @throws {never} Never.
 */
function questionnaireLines(questions: readonly { question: string }[], output: unknown): string[] {
  const result = output as AskUserResult | undefined;
  const replied = result !== undefined && "repliedInChat" in result;
  const answers = result !== undefined && "answers" in result ? result.answers : undefined;
  const lines = questions.flatMap((q, i) => {
    const n = String(i + 1);
    const asked = `Q${n} ${q.question}`;
    if (answers === undefined) return [asked];
    const a = answers.find((x) => x.index === i);
    const picked = a?.selected ?? [];
    const other = a?.other;
    if (picked.length === 0 && other === undefined) return [asked, `A${n} skipped`];
    if (picked.length === 0) return [asked, `A${n} other: ${String(other)}`];
    return [asked, `A${n} ${picked.join(", ")}${other === undefined ? "" : ` / other: ${other}`}`];
  });
  return replied ? [...lines, "the user wrote a message instead"] : lines;
}

/**
 * An old single-question card's input (`{ question, options }` with string
 * options), which held no answer.
 * @param input - The call's stored input.
 * @returns The question and its options, or null for any other shape.
 * @throws {never} Never.
 */
function oldQuestion(input: unknown): { question: string; options: string[] } | null {
  if (typeof input !== "object" || input === null) return null;
  const { question, options } = input as Record<string, unknown>;
  if (typeof question !== "string") return null;
  return { question, options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [] };
}

/**
 * A value as a list, the way a lax jsonpath step reads it: an array is its
 * items, anything else one item, nothing no item.
 * @param value - The value.
 * @returns The items.
 * @throws {never} Never.
 */
function laxItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

/**
 * A field of every item that is a record.
 * @param items - The items.
 * @param key - The field.
 * @returns The field's values, each read as a lax list.
 * @throws {never} Never.
 */
function fieldOf(items: unknown[], key: string): unknown[] {
  return items.flatMap((item) =>
    typeof item === "object" && item !== null && !Array.isArray(item) ? laxItems((item as Record<string, unknown>)[key]) : [],
  );
}

/**
 * The strings among some values.
 * @param values - The values.
 * @returns Those that are strings.
 * @throws {never} Never.
 */
function onlyStrings(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string");
}

/**
 * An `ask_user` call neither reader accepts, written from the fields the
 * server's search matches for `ask_user` (`searchableWords` in the
 * conversation message repo), uncut as the search leaves them.
 * @param part - The call.
 * @returns Its questions, options and answers, one line each.
 * @throws {never} Never.
 */
function looseAskLines(part: ToolPart): string[] {
  const input = laxItems(part.input);
  const questions = [...onlyStrings(fieldOf(fieldOf(input, "questions"), "question")), ...onlyStrings(fieldOf(input, "question"))];
  const options = onlyStrings(fieldOf(input, "options"));
  const answers = fieldOf(laxItems(part.output), "answers").flatMap((a): string[] => {
    const picked = onlyStrings(fieldOf([a], "selected"));
    const other = onlyStrings(fieldOf([a], "other"));
    if (picked.length === 0 && other.length === 0) return [];
    const index = (a as { index?: unknown }).index;
    const n = typeof index === "number" && Number.isInteger(index) && index >= 0 ? String(index + 1) : "";
    const words = [...(picked.length > 0 ? [picked.join(", ")] : []), ...other.map((o) => `other: ${o}`)];
    return [`A${n} ${words.join(" / ")}`];
  });
  return [
    ...questions.map((q, i) => `Q${String(i + 1)} ${q}`),
    ...(options.length > 0 ? [`options: ${options.join(", ")}`] : []),
    ...answers,
  ];
}

/**
 * One tool call written out.
 * @param part - The call.
 * @returns Its lines.
 * @throws {never} Never.
 */
function toolLines(part: ToolPart): string[] {
  const questionnaire = part.toolName === ASK_USER ? readQuestionnaire(part.input) : null;
  if (questionnaire) return questionnaireLines(questionnaire.questions, part.output);
  const old = part.toolName === ASK_USER ? oldQuestion(part.input) : null;
  if (old) return [`Q1 ${old.question}`, ...(old.options.length > 0 ? [`options: ${old.options.join(", ")}`] : [])];
  if (part.toolName === ASK_USER) return looseAskLines(part);
  const called = `[called ${part.toolName}]${wordsOf(part.input)}`;
  if (part.output === undefined || isRecordTool(part.toolName)) return [called];
  return [called, `[${part.toolName} answered]${wordsOf(part.output)}`];
}

/**
 * The part of a text kept at a length, and how many characters were cut.
 * @param text - The text.
 * @param max - How many characters to keep.
 * @returns The kept part, and the count cut (0 when it fit).
 * @throws {never} Never.
 */
export function keptText(text: string, max: number): { kept: string; cut: number } {
  const length = [...text].length;
  return length <= max ? { kept: text, cut: 0 } : { kept: clip(text, max), cut: length - max };
}

/**
 * What follows a cut text, saying how many characters it lost.
 * @param cut - How many were cut.
 * @returns The marker with a leading space, or nothing when none were cut.
 * @throws {never} Never.
 */
export function cutMarker(cut: number): string {
  return cut === 0 ? "" : ` [${String(cut)} more characters cut]`;
}

/**
 * A text cut to a length, saying how many characters it lost: a text part of
 * a message.
 * @param text - The text.
 * @param max - How many characters to keep.
 * @returns The text, followed by how much was cut when it was longer.
 * @throws {never} Never.
 */
export function cutText(text: string, max: number): string {
  const { kept, cut } = keptText(text, max);
  return `${kept}${cutMarker(cut)}`;
}

/**
 * A stored message's readable text: what was said, attached, asked and
 * answered, in order, one part after another on its own line.
 * @param parts - The message's parts.
 * @returns The text.
 * @throws {never} Never.
 */
export function messageText(parts: MessagePart[]): string {
  return parts
    .flatMap((part): string[] => {
      switch (part.type) {
        case "text":
          return [cutText(part.text, getAgentConfig().records_page_max_chars)];
        case "attachment":
          return [`[attached: ${part.chip.name}]`];
        case "tool":
          return toolLines(part);
        default:
          return [];
      }
    })
    .join("\n");
}
