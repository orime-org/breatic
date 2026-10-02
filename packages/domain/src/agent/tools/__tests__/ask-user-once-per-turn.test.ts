// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn puts one question to the reader, and the tool is what holds that
 * line: a second call in the same turn is turned away, whatever the model
 * meant by it. The reader sees one question; the model is told the other was
 * not put, so it can ask it once the first is answered.
 */
import { describe, it, expect } from "vitest";
import { toolFailureOf } from "@breatic/shared";

import { makeAskUserTool } from "@domain/agent/tools/ask-user.js";

const asked = { question: "Which style do you want?", options: ["Ink", "Oil"] };
const alsoAsked = { question: "How long should it be?" };

/**
 * Run the tool's execute the way the SDK does.
 * @param tool - The tool for one turn.
 * @param input - The arguments the model sent.
 * @returns What execute answered.
 */
function ask(tool: ReturnType<typeof makeAskUserTool>, input: object): Promise<unknown> {
  const execute = tool.execute as (input: object, options: object) => Promise<unknown>;
  return execute(input, {});
}

describe("one question a turn", () => {
  it("answers the first call with the question it was given", async () => {
    expect(await ask(makeAskUserTool(), asked)).toStrictEqual(asked);
  });

  it("turns away a second call in the same turn, telling the model why", async () => {
    const tool = makeAskUserTool();
    await ask(tool, asked);

    let thrown: unknown;
    await ask(tool, alsoAsked).catch((err: unknown) => {
      thrown = err;
    });
    const failure = toolFailureOf(thrown);
    expect(failure?.kind).toBe("turned_away");
    // Read again by the next turn, when the first question has an answer:
    // past tense, and it says what to do now.
    expect(failure?.forModel).toMatch(/was not put to the user/i);
    expect(failure?.forModel).toMatch(/one question a turn/i);
    expect(failure?.forModel).toMatch(/once the first one is answered/i);
  });

  it("gives every turn its own question", async () => {
    await ask(makeAskUserTool(), asked);
    expect(await ask(makeAskUserTool(), alsoAsked)).toStrictEqual(alsoAsked);
  });

  it("lets the first of two calls started together through, and only that one", async () => {
    // How the SDK runs a step's calls: started in the order the model sent
    // them, then awaited together.
    const tool = makeAskUserTool();
    const settled = await Promise.allSettled([ask(tool, asked), ask(tool, alsoAsked)]);
    expect(settled[0]).toStrictEqual({ status: "fulfilled", value: asked });
    expect(settled[1]?.status).toBe("rejected");
  });
});
