// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading a consolidation answer (#1363, #1336, #961).
 *
 * The answer is a progress note and a list of operations on single entries.
 * It is checked twice: its shape, and what it may touch -- an update or a
 * delete may name only an entry the consolidation was shown in full, and no
 * entry twice. Every problem comes back as its own line, worded so the model
 * can correct the answer when it is asked again.
 */
import { describe, expect, it } from "vitest";
import { readConsolidationAnswer } from "@server/agent/consolidation-answer.js";

const SHOWN = "44444444-4444-4444-8444-444444444444";
const TITLE_ONLY = "55555555-5555-4555-8555-555555555555";

const RULES = { editable: new Set([SHOWN]), maxOperations: 3, progressMaxChars: 40 };

/**
 * An answer as the model would write it.
 * @param body - The answer's fields.
 * @returns Its JSON.
 */
function answer(body: unknown): string {
  return JSON.stringify(body);
}

/**
 * The errors an answer is refused with.
 * @param text - What the model replied.
 * @returns The errors, or a failure marker when it was accepted.
 */
function errorsOf(text: string): string[] {
  const read = readConsolidationAnswer(text, RULES);
  return read.ok ? ["accepted"] : read.errors;
}

describe("a consolidation answer that passes", () => {
  it("is read with its progress note and operations", () => {
    const read = readConsolidationAnswer(
      answer({
        progress: "Settled the look.",
        operations: [
          { op: "add", scope: "project", title: "Lead: Lin Wu", content: "Tear mole." },
          { op: "update", id: SHOWN, title: "Palette", content: "Teal and orange." },
        ],
      }),
      RULES,
    );

    expect(read).toEqual({
      ok: true,
      answer: {
        progress: "Settled the look.",
        operations: [
          { op: "add", scope: "project", title: "Lead: Lin Wu", content: "Tear mole." },
          { op: "update", id: SHOWN, title: "Palette", content: "Teal and orange." },
        ],
      },
    });
  });

  it("may carry no operations: nothing new was said", () => {
    expect(readConsolidationAnswer(answer({ progress: "Still on the look.", operations: [] }), RULES)).toEqual({
      ok: true,
      answer: { progress: "Still on the look.", operations: [] },
    });
  });

  it("is found inside a fenced block or prose around it", () => {
    const text = `Here it is:\n\`\`\`json\n${answer({ progress: "p", operations: [] })}\n\`\`\``;
    expect(readConsolidationAnswer(text, RULES)).toMatchObject({ ok: true });
  });
});

describe("a consolidation answer that is refused", () => {
  it("says so when there is no JSON object in it", () => {
    expect(errorsOf("I could not do it.")).toEqual(["The answer is not a JSON object."]);
  });

  it.each([
    ["no progress note", { operations: [] }, /progress/],
    ["an empty progress note", { progress: "   ", operations: [] }, /progress/],
    ["a progress note over its ceiling", { progress: "p".repeat(41), operations: [] }, /progress.*40/],
    ["no operations list", { progress: "p" }, /operations/],
    ["an add with no scope", { progress: "p", operations: [{ op: "add", title: "t", content: "c" }] }, /operations\.0\.scope/],
    ["a title over two lines", { progress: "p", operations: [{ op: "add", scope: "project", title: "a\nb", content: "c" }] }, /operations\.0\.title/],
    ["a title over 120 characters", { progress: "p", operations: [{ op: "add", scope: "project", title: "t".repeat(121), content: "c" }] }, /operations\.0\.title/],
    ["content over 4000 characters", { progress: "p", operations: [{ op: "add", scope: "project", title: "t", content: "c".repeat(4001) }] }, /operations\.0\.content/],
    ["an operation it does not know", { progress: "p", operations: [{ op: "merge", id: SHOWN }] }, /operations\.0/],
  ])("names the field for %s", (_label, body, field) => {
    const errors = errorsOf(answer(body));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(field);
  });

  it("refuses more operations than one answer may carry", () => {
    const ops = Array.from({ length: 4 }, (_, i) => ({ op: "add", scope: "project", title: `t${String(i)}`, content: "c" }));
    expect(errorsOf(answer({ progress: "p", operations: ops })).join("\n")).toMatch(/at most 3/);
  });

  it.each([
    ["update", { op: "update", id: TITLE_ONLY, title: "t", content: "c" }],
    ["delete", { op: "delete", id: TITLE_ONLY }],
  ])("refuses an %s of an entry it was shown only by title", (_op, operation) => {
    const errors = errorsOf(answer({ progress: "p", operations: [operation] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(TITLE_ONLY);
    expect(errors[0]).toMatch(/shown in full/);
  });

  it("refuses an entry named twice", () => {
    const errors = errorsOf(
      answer({
        progress: "p",
        operations: [
          { op: "update", id: SHOWN, title: "t", content: "c" },
          { op: "delete", id: SHOWN },
        ],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(SHOWN);
    expect(errors[0]).toMatch(/more than once/);
  });

  it("lists every problem, not only the first", () => {
    const errors = errorsOf(
      answer({
        progress: "",
        operations: [{ op: "delete", id: TITLE_ONLY }],
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});
