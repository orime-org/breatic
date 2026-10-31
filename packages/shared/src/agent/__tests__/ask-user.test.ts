// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reader's answers to a questionnaire, held to the questions they answer.
 */
import { describe, it, expect } from "vitest";

import {
  answersMismatch,
  askUserAnswerSchema,
  askUserInputSchema,
  ASK_USER_OTHER_MAX_CHARS,
  readQuestionnaire,
  type AskUserQuestion,
} from "@shared/agent/ask-user.js";

const QUESTIONS: AskUserQuestion[] = askUserInputSchema.parse({
  questions: [
    { header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] },
    {
      header: "Elements",
      question: "What should appear?",
      multiSelect: true,
      options: [{ label: "People" }, { label: "City" }, { label: "Product" }],
    },
    { header: "Mood", question: "Any mood in mind?" },
  ],
}).questions;

describe("answers that fit the questions", () => {
  it("pass with one option on a single-choice question", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 0, selected: ["9:16"] }])).toBeNull();
  });

  it("pass with several options on a question that takes several, plus words of the reader's own", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 1, selected: ["People", "City"], other: "A dog" }])).toBeNull();
  });

  it("pass with only words on an open question, the rest skipped", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 2, selected: [], other: "Calm" }])).toBeNull();
  });
});

describe("answers that do not fit", () => {
  it("name a question the card does not have", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 3, selected: [] }])).toBe("There is no question 4 on this card.");
  });

  it("answer one question twice", () => {
    expect(
      answersMismatch(QUESTIONS, [
        { index: 0, selected: ["16:9"] },
        { index: 0, selected: ["9:16"] },
      ]),
    ).toBe("Question 1 is answered twice.");
  });

  it("pick an option the question does not offer", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 0, selected: ["4:3"] }])).toBe(
      '"4:3" is not an option on question 1.',
    );
  });

  it("pick the same option twice", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 1, selected: ["City", "City"] }])).toBe(
      "An option is picked twice on question 2.",
    );
  });

  it("give two answers where one is taken, counting the reader's own words as one", () => {
    expect(answersMismatch(QUESTIONS, [{ index: 0, selected: ["16:9", "9:16"] }])).toBe(
      "Question 1 takes one answer.",
    );
    expect(answersMismatch(QUESTIONS, [{ index: 0, selected: ["16:9"], other: "4:3" }])).toBe(
      "Question 1 takes one answer.",
    );
  });

  it("answer nothing at all", () => {
    expect(answersMismatch(QUESTIONS, [])).toBe("At least one question is answered.");
    expect(answersMismatch(QUESTIONS, [{ index: 0, selected: [] }])).toBe("At least one question is answered.");
  });
});

describe("the answer the browser sends", () => {
  it("bounds the reader's own words", () => {
    const fits = { toolCallId: "call-1", answers: [{ index: 0, selected: [], other: "a".repeat(ASK_USER_OTHER_MAX_CHARS) }] };
    const over = { toolCallId: "call-1", answers: [{ index: 0, selected: [], other: "a".repeat(ASK_USER_OTHER_MAX_CHARS + 1) }] };
    expect(askUserAnswerSchema.safeParse(fits).success).toBe(true);
    expect(askUserAnswerSchema.safeParse(over).success).toBe(false);
  });

  it("refuses fields it does not know", () => {
    expect(askUserAnswerSchema.safeParse({ toolCallId: "call-1", answers: [], extra: 1 }).success).toBe(false);
  });
});

describe("the questions the model sends", () => {
  it("refuse two options with the same label in one question, naming it", () => {
    const parsed = askUserInputSchema.safeParse({
      questions: [{ header: "Style", question: "Which style?", options: [{ label: "Ink wash" }, { label: "Ink wash" }] }],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toContain('"Ink wash"');
  });

  it("take the same label on two different questions", () => {
    const label = { header: "Q", question: "Which?", options: [{ label: "Yes" }, { label: "No" }] };

    expect(askUserInputSchema.safeParse({ questions: [label, label] }).success).toBe(true);
  });
});

describe("reading a stored call", () => {
  it("is a questionnaire when it has the card's shape", () => {
    expect(readQuestionnaire({ questions: [{ header: "Mood", question: "Any mood?" }] })?.questions).toHaveLength(1);
  });

  it("is nothing for a call stored before the card existed", () => {
    expect(readQuestionnaire({ question: "Which pace?", options: ["Fast", "Slow"] })).toBeNull();
  });
});
