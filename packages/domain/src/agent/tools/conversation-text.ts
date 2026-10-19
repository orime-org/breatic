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
 * is cut on its own: a text part at the message length, saying how much it
 * lost, and a tool's words at the tool length. The search
 * in the server matches only words this writes out: the text parts, the
 * attachments' names, a questionnaire's questions and the answers given (an
 * old single-question card's question and options), and the strings of every
 * other tool's input, cut to the same length.
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
  const called = `[called ${part.toolName}]${wordsOf(part.input)}`;
  if (part.output === undefined || isRecordTool(part.toolName)) return [called];
  return [called, `[${part.toolName} answered]${wordsOf(part.output)}`];
}

/**
 * A text part, cut to the configured message length.
 * @param text - The part's text.
 * @returns The text, saying how much this part lost when it was cut.
 * @throws {never} Never.
 */
function cutText(text: string): string {
  const max = getAgentConfig().records_message_max_chars;
  const length = [...text].length;
  return length <= max ? text : `${clip(text, max)} [${String(length - max)} more characters cut]`;
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
          return [cutText(part.text)];
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
