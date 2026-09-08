// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A question the model asked is written into the reply as markdown.
 *
 * The payload is a question, a few options and a line on how to answer, and
 * drawn it is the question on its own above a numbered list with that line
 * under it. Assembling that here rather than asking the model for it is what
 * makes the shape a fact instead of a request -- and the chat body folds
 * single newlines away, so the options have to be a real list.
 *
 * Built as a document and serialised, so what a line renders as is decided by
 * a serialiser that owns the whole of CommonMark rather than by a rule of ours
 * about which characters are dangerous. Where the paragraph sits in the reply
 * belongs to whoever writes it onto the stream, and is asserted there.
 *
 * Every word in it is the model's own, which is what keeps the whole paragraph
 * in the language the conversation is being held in. Telling the reader that a
 * number will do is a field of the call, drawn on its own under the list; a
 * line of ours pinned underneath would be the one part of the paragraph in a
 * language nobody chose for it.
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
    expect(drawn).toBe("哪一种？\n\n1. 一\n2. 二");
  });

  it("ends on the last option when the model said nothing about answering", () => {
    const drawn = askUserMarkdown({ question: "哪一种？", options: ["一", "二"] });
    const lines = drawn.split("\n").filter((line) => line !== "");
    expect(lines[lines.length - 1]).toBe("2. 二");
  });
});

describe("a line that would have opened a block of its own", () => {
  it("is written as the characters it is, not as the block", () => {
    // Serialised from a document rather than joined as strings, so a question
    // of three dashes stays a question instead of becoming a rule with no
    // question above it, and an option that numbers itself stays one item.
    expect(askUserMarkdown({ question: "---", options: ["快", "慢"] })).toBe(
      "\\---\n\n1. 快\n2. 慢",
    );
    expect(askUserMarkdown({ question: "哪种？", options: ["1. 快切", "慢"] })).toBe(
      "哪种？\n\n1. 1\\. 快切\n2. 慢",
    );
    expect(askUserMarkdown({ question: "哪种？", options: [">60 秒", "30 秒"] })).toBe(
      "哪种？\n\n1. \\>60 秒\n2. 30 秒",
    );
  });

  it("leaves alone the punctuation that opens nothing", () => {
    expect(askUserMarkdown({ question: "哪种？", options: ["|竖屏|", "16:9 横屏"] })).toBe(
      "哪种？\n\n1. |竖屏|\n2. 16:9 横屏",
    );
  });
});

describe("a value the panel would read as syntax of its own", () => {
  it("survives the grammars the panel adds on top of CommonMark", () => {
    // The panel parses CommonMark plus GFM plus math (`MarkdownMessage.tsx`
    // runs `remarkGfm` and `remarkMath`), on its own settings. Escaping for
    // CommonMark alone leaves whatever those two add to be re-read as syntax:
    // rendered through the real `MarkdownMessage`, a CommonMark-only drawing
    // of the first case here comes out `时长 20<del>25 秒还是 30</del>35 秒？`,
    // with the middle of the question deleted.
    expect(
      askUserMarkdown({ question: "时长 20~25 秒还是 30~35 秒？", options: ["短", "长"] }),
    ).toBe("时长 20\\~25 秒还是 30\\~35 秒？\n\n1. 短\n2. 长");

    // One escape, not two: the panel reads `$` as a formula only in pairs
    // (`singleDollarTextMath: false`), so breaking the pair is the whole of
    // what this needs. Rendered back, it is `$$100` again.
    expect(askUserMarkdown({ question: "预算是 $$100 还是 $$500？" })).toBe(
      "预算是 \\$$100 还是 \\$$500？",
    );
  });

  it("keeps a link the model wrote pointing where it points", () => {
    // GFM turns a bare URL into a link and reads the backslashes of a
    // CommonMark escape as part of the address: `photo\_1.jpg` arrives as
    // `photo%5C_1.jpg` and the link 404s. Escaping for the same grammar the
    // panel parses leaves the address whole.
    expect(askUserMarkdown({ question: "用 https://a.com/photo_1.jpg 吗？" })).toBe(
      "用 https\\://a.com/photo\\_1.jpg 吗？",
    );
  });
});

describe("one option", () => {
  it("is drawn as a list of one", () => {
    // The floor the model can see is the ceiling; a single option is what it
    // asked for, and drawing it beats refusing a call over a rule it was
    // never shown.
    expect(askUserMarkdown({ question: "要不要继续？", options: ["继续"] })).toBe(
      "要不要继续？\n\n1. 继续",
    );
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

    expect(drawn).toBe("哪一种？\n\n1. 一\n2. 二\n\n回一个数字就行，也可以直接说你的想法。");
  });

  it("sits under an open question too, when there is one", () => {
    const drawn = askUserMarkdown({
      question: "这段片子给谁看？",
      options: [],
      howToAnswer: "随便说说就行。",
    });

    expect(drawn).toBe("这段片子给谁看？\n\n随便说说就行。");
  });
});

describe("a question with nothing to choose from", () => {
  it("is the question and nothing else", () => {
    const drawn = askUserMarkdown({ question: "这段片子给谁看？", options: [] });
    expect(drawn).toBe("这段片子给谁看？");
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
    expect(zh).toBe("哪一种？\n\n1. 一\n2. 二");
  });
});
