// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a consolidation answer (#1363, #1336, #961).
 *
 * The answer is a progress note and a list of operations on single entries.
 * It is checked for its shape, and for what it may touch: an update or a
 * delete may name only an entry the consolidation was shown in full, and no
 * entry twice. Every problem is returned as its own line, worded for the
 * model, which is asked again with them.
 */

import { z } from "zod";
import { memoryContent as content, memoryTitle as title } from "@breatic/domain";
import type { MemoryOperation } from "@server/modules/memory/memory.service.js";

/** What an answer is checked against. */
export interface AnswerRules {
  /** The entries the consolidation was shown in full, which it may update or delete. */
  editable: ReadonlySet<string>;
  /** How many operations one answer may carry. */
  maxOperations: number;
  /** How long the progress note may be, in characters. */
  progressMaxChars: number;
}

/** A checked answer. */
export interface ConsolidationAnswer {
  progress: string;
  operations: MemoryOperation[];
}

/** How reading an answer ended. */
export type AnswerRead = { ok: true; answer: ConsolidationAnswer } | { ok: false; errors: string[] };

/**
 * How many characters a text holds, counted by code point.
 * @param text - The text.
 * @returns Its length.
 * @throws {never} Never.
 */
function characters(text: string): number {
  return [...text].length;
}

const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), scope: z.enum(["project", "conversation"]), title, content }).strict(),
  z.object({ op: z.literal("update"), id: z.string().uuid(), title, content }).strict(),
  z.object({ op: z.literal("delete"), id: z.string().uuid() }).strict(),
]);

/**
 * The schema for one answer under these rules.
 * @param rules - The rules.
 * @returns The schema.
 * @throws {never} Never.
 */
function answerSchema(rules: AnswerRules): z.ZodType<ConsolidationAnswer> {
  return z
    .object({
      progress: z
        .string()
        .trim()
        .min(1, "must not be empty")
        .refine(
          (p) => characters(p) <= rules.progressMaxChars,
          `must be at most ${String(rules.progressMaxChars)} characters`,
        ),
      operations: z
        .array(operation)
        .max(rules.maxOperations, `must hold at most ${String(rules.maxOperations)} operations`),
    })
    .strict();
}

/**
 * The JSON object in a reply, wherever it sits.
 * @param text - What the model replied.
 * @returns The parsed value, or undefined when there is none.
 * @throws {never} Never.
 */
function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Read and check one consolidation answer.
 * @param text - What the model replied.
 * @param rules - What it is checked against.
 * @returns The answer, or every problem found in it.
 * @throws {never} Never.
 */
export function readConsolidationAnswer(text: string, rules: AnswerRules): AnswerRead {
  const value = jsonIn(text);
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["The answer is not a JSON object."] };
  }
  const parsed = answerSchema(rules).safeParse(value);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "answer"}: ${issue.message}`);
  // What the operations may touch is checked whenever they parse, so an
  // answer wrong in both ways hears about both at once.
  const operations = z.array(operation).safeParse((value as { operations?: unknown }).operations);
  const named = new Set<string>();
  for (const op of operations.success ? operations.data : []) {
    if (op.op === "add") continue;
    if (!rules.editable.has(op.id)) {
      errors.push(
        `${op.op} ${op.id}: only an entry shown in full under "Current entries" may be updated or deleted; ` +
          "this one was shown by title only, or not at all.",
      );
    } else if (named.has(op.id)) {
      errors.push(`${op.op} ${op.id}: names an entry more than once; give each entry at most one operation.`);
    }
    named.add(op.id);
  }
  if (errors.length > 0 || !parsed.success) return { ok: false, errors };
  return { ok: true, answer: parsed.data };
}
