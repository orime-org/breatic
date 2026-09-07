// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A question the model asked is written into the reply as markdown.
 *
 * The payload is a question and a few options, and drawn it is the question on
 * its own above a numbered list. Assembling that here rather than asking the
 * model for it is what makes the shape a fact instead of a request -- and the
 * chat body folds single newlines away, so the options have to be a real list.
 *
 * Every word in it is the model's own, which is what keeps the whole paragraph
 * in the language the conversation is being held in. Telling the reader that a
 * number will do is something the model says in its question when it helps;
 * a line of ours pinned underneath would be the one part of the paragraph in
 * a language nobody chose for it.
 */
import { describe, it, expect } from "vitest";
import { runWithLocale } from "@breatic/core";

import { askUserMarkdown } from "@server/agent/ask-user-text.js";

describe("a question with options", () => {
  it("puts the question on its own and numbers the options from one", () => {
    const drawn = askUserMarkdown({
      question: "这段片子的节奏，你想要哪种？",
      options: ["快切，跟着鼓点走", "中速，让画面自己说话", "慢，留白多一些"],
    });

    const lines = drawn.split("\n").filter((line) => line !== "");
    expect(lines[0]).toBe("这段片子的节奏，你想要哪种？");
    expect(lines[1]).toBe("1. 快切，跟着鼓点走");
    expect(lines[2]).toBe("2. 中速，让画面自己说话");
    expect(lines[3]).toBe("3. 慢，留白多一些");
  });

  it("separates the question from the list with a blank line", () => {
    // A single newline is folded away in the chat body, so a question sitting
    // directly above its list would run into the first item.
    const drawn = askUserMarkdown({ question: "哪一种？", options: ["一", "二"] });
    expect(drawn).toBe("\n\n哪一种？\n\n1. 一\n2. 二\n\n");
  });

  it("ends on the last option when the model said nothing about answering", () => {
    const drawn = askUserMarkdown({ question: "哪一种？", options: ["一", "二"] });
    const lines = drawn.split("\n").filter((line) => line !== "");
    expect(lines[lines.length - 1]).toBe("2. 二");
  });
});

describe("where this paragraph starts and ends", () => {
  it("is fenced by blank lines, because the panel concatenates text parts raw", () => {
    // `to-chat-message.ts` builds one string with `content += part.text` and
    // hands it to one markdown render. Without a blank line of its own, this
    // paragraph runs into whatever the model wrote before it, and a second
    // question lands inside the first one's last option.
    const drawn = askUserMarkdown({ question: "哪一种？", options: ["一", "二"] });

    expect(drawn.startsWith("\n\n")).toBe(true);
    expect(drawn.endsWith("\n\n")).toBe(true);
  });

  it("keeps two of them apart when they are concatenated", () => {
    const first = askUserMarkdown({ question: "先定节奏？", options: ["快", "慢"] });
    const second = askUserMarkdown({ question: "再定时长？", options: ["30 秒", "60 秒"] });

    // What the panel would render: the second question must be its own
    // paragraph, not the tail of the first list's last item.
    expect(first + second).toContain("2. 慢\n\n\n\n再定时长？");
  });
});

describe("what the model says about answering", () => {
  it("goes in a paragraph of its own under the list", () => {
    // The tool decides where it sits; the model decides whether to say it,
    // what it says, and what language it is in.
    const drawn = askUserMarkdown({
      question: "哪一种？",
      options: ["一", "二"],
      howToAnswer: "回一个数字就行，也可以直接说你的想法。",
    });

    expect(drawn).toBe("\n\n哪一种？\n\n1. 一\n2. 二\n\n回一个数字就行，也可以直接说你的想法。\n\n");
  });

  it("sits under an open question too, when there is one", () => {
    const drawn = askUserMarkdown({
      question: "这段片子给谁看？",
      options: [],
      howToAnswer: "随便说说就行。",
    });

    expect(drawn).toBe("\n\n这段片子给谁看？\n\n随便说说就行。\n\n");
  });
});

describe("a question with nothing to choose from", () => {
  it("is the question and nothing else", () => {
    const drawn = askUserMarkdown({ question: "这段片子给谁看？", options: [] });
    expect(drawn).toBe("\n\n这段片子给谁看？\n\n");
  });
});

describe("what language the paragraph comes out in", () => {
  it("is whatever the model wrote, since nothing here is ours to translate", () => {
    // The same payload under two request locales. A word of ours anywhere in
    // the output would make these differ, and the reader would get one line of
    // a paragraph in a language the rest of it is not in.
    const zh = runWithLocale("zh-CN", () =>
      askUserMarkdown({ question: "哪一种？", options: ["一", "二"] }),
    );
    const en = runWithLocale("en", () =>
      askUserMarkdown({ question: "哪一种？", options: ["一", "二"] }),
    );

    expect(en).toBe(zh);
    expect(zh).toBe("\n\n哪一种？\n\n1. 一\n2. 二\n\n");
  });
});
