// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A stored message as the record tools write it out (inner#1469).
 *
 * The words a user saw said are not all in a message's text parts: the
 * answers to a questionnaire live in the `ask_user` call's result, and a
 * proposal's prompts in the call's input. Reading a conversation back carries
 * those, and leaves out what was never shown as said -- the model's thinking
 * and the markers of how a turn ended. The search in the server matches the
 * same strings: the text parts, and every string inside a tool's input and
 * result.
 */

import { getAgentConfig } from "@breatic/core";
import { readQuestionnaire, type AskUserResult, type MessagePart } from "@breatic/shared";

import { clip } from "@domain/agent/tools/failure.js";
import { ASK_USER } from "@domain/agent/tools/tool-names.js";

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
 * @returns The strings joined, with a leading space, or nothing when it holds none.
 * @throws {never} Never.
 */
function wordsOf(value: unknown): string {
  const words = stringsOf(value).join(" ");
  return words === "" ? "" : ` ${clip(words, getAgentConfig().records_tool_text_max_chars)}`;
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
 * One tool call written out.
 * @param part - The call.
 * @returns Its lines.
 * @throws {never} Never.
 */
function toolLines(part: ToolPart): string[] {
  const questionnaire = part.toolName === ASK_USER ? readQuestionnaire(part.input) : null;
  if (questionnaire) return questionnaireLines(questionnaire.questions, part.output);
  const called = `[called ${part.toolName}]${wordsOf(part.input)}`;
  return part.output === undefined ? [called] : [called, `[${part.toolName} answered]${wordsOf(part.output)}`];
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
          return [part.text];
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
