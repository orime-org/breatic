// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A question the model asked is written into the reply as markdown.
 *
 * The payload is a question and a few options, and drawn it is a paragraph:
 * the question on its own, the options as a numbered list, and one fixed line
 * saying a number is enough. Assembling it here rather than asking the model
 * for it is what makes the shape a fact instead of a request -- and the chat
 * body folds single newlines away, so the options have to be a real list.
 *
 * The closing line is ours, so it is translated. It takes the interface
 * language the request negotiated, which is the one the reader picked.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { runWithLocale, loadLocales } from "@breatic/core";

import { askUserMarkdown } from "@server/agent/ask-user-text.js";

// The real catalogue, because what is asserted below is the copy a reader
// gets. Service entry points do this at boot; nothing has booted here.
beforeAll(() => {
  loadLocales();
});

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
    expect(drawn).toContain("哪一种？\n\n1. 一");
  });

  it("closes with the line saying a number is enough", () => {
    // Pinned, because outside a request the catalogue answers in English.
    const drawn = runWithLocale("zh-CN", () =>
      askUserMarkdown({ question: "哪一种？", options: ["一", "二"] }),
    );
    const lines = drawn.split("\n").filter((line) => line !== "");
    expect(lines[lines.length - 1]).toBe("回一个数字就行，也可以直接说你的想法。");
  });
});

describe("a question with nothing to choose from", () => {
  it("is the question and nothing else", () => {
    const drawn = askUserMarkdown({ question: "这段片子给谁看？", options: [] });
    expect(drawn).toBe("这段片子给谁看？");
  });
});

describe("the language of the line we wrote", () => {
  it("follows the one the request negotiated", async () => {
    const zh = await runWithLocale("zh-CN", () =>
      Promise.resolve(askUserMarkdown({ question: "哪一种？", options: ["一", "二"] })),
    );
    const en = await runWithLocale("en", () =>
      Promise.resolve(askUserMarkdown({ question: "哪一种？", options: ["一", "二"] })),
    );

    expect(zh).toContain("回一个数字就行");
    expect(en).not.toContain("回一个数字就行");
    // The question itself is the model's own words and is untouched by this.
    expect(en).toContain("哪一种？");
  });
});
