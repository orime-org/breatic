// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four interaction tools hand back a payload, not a marked-up string.
 *
 * These four do not act on anything. They carry a payload the frontend
 * renders: a question, a set of choices, a proposed canvas change, a grid of
 * results. Today each one glues a sentinel in front of the JSON --
 * `__ASK_USER__{...}` -- and the turn loop reads the prefix to tell which of
 * them spoke, strips it, and emits an event of its own.
 *
 * The prefix exists to carry one fact: which tool this output came from. A
 * tool part carries that already, in its own type: `tool-ask_user_question`,
 * `tool-ask_user_choice`, and so on. So the prefix goes, the string goes, and
 * `execute` returns the payload itself.
 */
import { describe, it, expect } from "vitest";
import { TOOL_MAP } from "@domain/agent/tools/index.js";
import type { Tool } from "ai";

/** What a tool's `execute` looks like once we stop caring about its types. */
type ExecuteFn = (
  input: Record<string, unknown>,
  options: { abortSignal?: AbortSignal },
) => Promise<unknown>;

/**
 * The four tools that exist to put something on screen, with an input each
 * that satisfies their schema.
 *
 * Named one by one rather than derived from the map: a fifth interaction tool
 * should have to be added here deliberately, and the inputs cannot be
 * generated -- `ask_user_choice` needs two choices, `propose_canvas_action`
 * needs an action its enum accepts.
 */
const INTERACTION_TOOLS: Array<{
  name: string;
  input: Record<string, unknown>;
  /** A field the payload must carry through, so an empty object cannot pass. */
  carries: string;
}> = [
  {
    name: "ask_user_question",
    input: { question: "哪个方向？", options: ["左", "右"] },
    carries: "question",
  },
  {
    name: "ask_user_choice",
    input: {
      question: "选一个",
      choices: [
        { id: "a", label: "第一个" },
        { id: "b", label: "第二个" },
      ],
    },
    carries: "choices",
  },
  {
    name: "propose_canvas_action",
    input: { action: "delete_node", rationale: "重复了" },
    carries: "action",
  },
  {
    name: "show_search_results",
    input: { links: [], sourceQuery: "参考图" },
    carries: "sourceQuery",
  },
];

/** Every sentinel the four used to glue on, by hand rather than by import. */
const SENTINELS = [
  "__ASK_USER__",
  "__ASK_USER_CHOICE__",
  "__PROPOSE_CANVAS_ACTION__",
  "__SHOW_SEARCH_RESULTS__",
];

/**
 * Run one registered tool.
 * @param name - Its name in `TOOL_MAP`.
 * @param input - Arguments matching that tool's schema.
 * @returns Whatever `execute` resolves to.
 * @throws {Error} If the tool is not registered or has no `execute`.
 */
async function run(name: string, input: Record<string, unknown>): Promise<unknown> {
  const tool: Tool | undefined = TOOL_MAP[name];
  const execute = (tool as { execute?: unknown } | undefined)?.execute as
    | ExecuteFn
    | undefined;
  if (!execute) throw new Error(`${name} 没有注册，或者它没有 execute`);
  return execute(input, {});
}

describe("what an interaction tool hands back", () => {
  for (const { name, input, carries } of INTERACTION_TOOLS) {
    it(`${name} returns the payload itself`, async () => {
      const output = await run(name, input);

      // An object, because the frontend reads fields off it and the model
      // reads it as structured arguments. A string would mean someone is
      // still parsing text to find out what happened.
      expect(typeof output).toBe("object");
      expect(output).not.toBeNull();
      expect(output).toHaveProperty(carries);
    });

    it(`${name} carries no sentinel prefix`, async () => {
      const output = await run(name, input);
      // Serialised rather than checked field by field: a prefix hiding in a
      // nested string is the same defect as one on the front.
      const serialised = JSON.stringify(output);
      for (const sentinel of SENTINELS) {
        expect(serialised).not.toContain(sentinel);
      }
    });
  }
});

describe("the sentinel mechanism", () => {
  it("is gone from what the tools package exports", async () => {
    // The prefixes were exported so the turn loop could match on them. With
    // the loop gone and the tool part carrying the name, an export that
    // survives means a reader somewhere survived with it.
    const tools = await import("@domain/agent/tools/index.js");
    const exported = Object.keys(tools).filter((key) => key.endsWith("_SENTINEL"));
    expect(exported).toEqual([]);
  });
});
