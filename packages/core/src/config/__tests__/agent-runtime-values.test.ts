// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Three figures this build reads from `config/agent.yaml` rather than source.
 *
 * The model is one of them because a model id is data, not a choice made in
 * code. The other two are on the path between pressing send and the first
 * frame arriving: how often the server says the stream is alive, and how many
 * messages one page of a conversation holds. Both were literals -- the beat
 * in `shared/src/agent/sse-events.ts`, the page size in the message repo as
 * `MAX_HISTORY = 50`, a figure with no recorded reason.
 *
 * How many missed beats mean the stream is gone stays in code at three, and
 * deliberately: the server garbage collects, two misses in a row happen to a
 * healthy stream, and a deployment that tuned this down would start killing
 * turns that were doing fine.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { agentConfigSchemaForTests } from "@core/config/loader.js";

/** The model every chat turn and every consolidation runs on. */
const MODEL = "deepseek/deepseek-v4-pro";

/**
 * The shipped `config/agent.yaml`, parsed.
 *
 * Read straight off disk rather than through `getAgentConfig`, which wants
 * the environment loaded first. What is being checked here is the file we
 * ship, so the file is what gets opened.
 * @returns Its top-level keys and values.
 */
function shippedConfig(): Record<string, unknown> {
  const path = resolve(import.meta.dirname, "../../../../../config/agent.yaml");
  return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Every default the schema hands back when the file says nothing.
 * @returns The parsed defaults.
 */
function defaults(): Record<string, unknown> {
  return agentConfigSchemaForTests.parse({});
}

describe("the model this build talks to", () => {
  it("is DeepSeek V4 Pro in the shipped config", () => {
    const config = shippedConfig();
    expect(config.default_model).toBe(MODEL);
    // Consolidation summarises old turns. Leaving it on the previous model
    // would mean a conversation is read by one model and written by another,
    // and the bill would name two.
    expect(config.consolidation_model).toBe(MODEL);
  });

  it("is the schema default too, so a missing key cannot resurrect the old one", () => {
    const parsed = defaults();
    expect(parsed.default_model).toBe(MODEL);
    expect(parsed.consolidation_model).toBe(MODEL);
  });
});

describe("the figures on the path from pressing send to the first frame", () => {
  it("declares how often the server says the stream is alive", () => {
    expect(defaults().sse_heartbeat_interval_ms).toBe(5000);
    expect(shippedConfig().sse_heartbeat_interval_ms).toBe(5000);
  });

  it("declares how many messages one page of a conversation holds", () => {
    // Thirty, the same figure `conversation_page_size` already uses: the two
    // are the same kind of dial and whoever reads this file should not have
    // to hold two numbers. The 50 it replaces had no reason written anywhere.
    expect(defaults().message_page_size).toBe(30);
    expect(shippedConfig().message_page_size).toBe(30);
  });

  it("rejects a page size or interval that is not a positive whole number", () => {
    // These reach a timer and a SQL limit. A zero, a negative or a fraction
    // is not a slower stream or a shorter page -- it is a stream that never
    // says anything and a page that returns nothing.
    for (const bad of [0, -1, 1.5]) {
      expect(agentConfigSchemaForTests.safeParse({ message_page_size: bad }).success).toBe(
        false,
      );
      expect(
        agentConfigSchemaForTests.safeParse({ sse_heartbeat_interval_ms: bad }).success,
      ).toBe(false);
    }
  });
});

describe("the two memory lines", () => {
  it("refuses a keep line at or above the budget", () => {
    // A pass runs when the request is over the budget and takes turns until
    // what remains is at or under the keep line. With keep the higher of the
    // two, the loop stops before it has taken anything, the plan comes back
    // empty, and folding never happens again — with nothing said anywhere.
    expect(
      agentConfigSchemaForTests.safeParse({
        memory_budget_chars: 500_000,
        memory_keep_chars: 500_000,
      }).success,
    ).toBe(false);
    expect(
      agentConfigSchemaForTests.safeParse({
        memory_budget_chars: 400_000,
        memory_keep_chars: 500_000,
      }).success,
    ).toBe(false);
  });

  it("takes the pair the file ships with", () => {
    const config = shippedConfig();
    // Both read off disk, so editing either line in the file is what this
    // answers. Their presence is asserted first: absent, the schema hands
    // back its own defaults and the pair being checked would be one nobody
    // ships.
    expect(typeof config.memory_budget_chars).toBe("number");
    expect(typeof config.memory_keep_chars).toBe("number");
    expect(
      agentConfigSchemaForTests.safeParse({
        memory_budget_chars: config.memory_budget_chars,
        memory_keep_chars: config.memory_keep_chars,
      }).success,
    ).toBe(true);
  });

  it("refuses memory ceilings that leave a pass nothing to run to", () => {
    // A pass runs to the keep line less the room the fold may add to memory,
    // so the two ceilings together have to leave something under it. Take the
    // whole of it and every fold swallows the conversation entire; take more
    // and the line goes negative, which the loop reads as "never stop".
    expect(
      agentConfigSchemaForTests.safeParse({
        memory_budget_chars: 850_000,
        memory_keep_chars: 500_000,
        memory_conversation_max_size: 250_000,
        memory_project_max_size: 250_000,
      }).success,
    ).toBe(false);
    expect(
      agentConfigSchemaForTests.safeParse({
        memory_budget_chars: 850_000,
        memory_keep_chars: 500_000,
        memory_conversation_max_size: 400_000,
        memory_project_max_size: 200_000,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["server", "../../../../server/src/index.ts"],
    ["worker", "../../../../worker/src/index.ts"],
  ])("is read by the %s at startup, not on the first request", (_name, path) => {
    // The reader is lazy, like every config reader here, so a file the schema
    // now refuses would otherwise be found by whoever spoke first: a 500 for
    // them, a process that started fine and a healthz still green behind it.
    // What is asserted is only that the call is still in the entry — whether
    // it exits is the entry's own `process.exit(1)`, three lines below it.
    const entry = readFileSync(resolve(import.meta.dirname, path), "utf8");
    // The call, and the exit that makes it a preflight rather than a read.
    // Matching the call alone passes on one sitting in a comment, or on one
    // whose failure is swallowed — either of which starts the process on a
    // config the schema refuses.
    expect(entry).toMatch(
      /\n\s*getAgentConfig\(\);\n\} catch \(err\) \{[\s\S]{0,300}?process\.exit\(1\);/,
    );
  });
});
