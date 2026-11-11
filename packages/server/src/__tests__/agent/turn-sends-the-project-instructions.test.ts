// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A turn sends the Project Instructions as the last part of the system prompt,
 * on every request, and nowhere else (#1400).
 *
 * The system prompt goes out whole on each request and is never stored with
 * the conversation, so the instructions are not replayed with the history and
 * the user's message, and the copy of it kept for later turns, do not carry
 * them. While they read the same, a reply goes back with its thinking, as any
 * reply whose request prefix still matches does; once they change, the next
 * turn sends the new text. Each reading of the turn's context reads them
 * afresh, with the memory: a questionnaire answered later sends what is
 * written then, and a reassembly after a fold still ends with them.
 *
 * Driven through `MainAgent` with the scripted model and the fake
 * conversation of `overflow-turn.ts`; `world.projectInstructions` is what
 * each read of the context finds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { askResultForModel } from "@server/agent/ask-result.js";
import {
  PROBE_WINDOW,
  answers,
  asks,
  callsFetch,
  h1,
  plainTurn,
  resetWorld,
  rowsOf,
  sendAnswer,
  sendMessage,
  systemOf,
  thinksThenAnswers,
  world,
} from "../helpers/overflow-turn.js";

vi.mock("@breatic/core", async (importOriginal) => (await import("../helpers/overflow-turn.js")).overflowCore(importOriginal));
vi.mock("@breatic/domain", async () => (await import("../helpers/overflow-turn.js")).overflowDomain());
vi.mock("@server/modules", async (importOriginal) => (await import("../helpers/mock-core.js")).serverModulesMock(importOriginal));
vi.mock("@server/modules/conversation/conversation-message.repo.js", async () => (await import("../helpers/overflow-turn.js")).overflowRepo());
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ getMessagesForLlm: async () => [], titleForTurn: async () => null }));
vi.mock("@server/agent/turn-context.js", async () => (await import("../helpers/overflow-turn.js")).overflowTurnContext());
vi.mock("@server/agent/memory-consolidator.js", async () => (await import("../helpers/overflow-turn.js")).overflowConsolidator());
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** The window of the fold cases, and the known count that leaves no room in it (200,000 - 16,384). */
const WINDOW = 200_000;
const LINE = 183_616;

/** What the members wrote, and what they changed it to. Neither contains the other. */
const WRITTEN = "Always reply in English. PALETTE-BLUE-AND-WHITE";
const REWRITTEN = "Reply in French from now on. PALETTE-TEAL";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T09:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetWorld();
  world.window = PROBE_WINDOW;
});

/**
 * The section the system prompt ends with for a text.
 * @param text - What the members wrote.
 * @returns The section.
 */
function section(text: string): string {
  return (
    "## Project Instructions\n\n" +
    "Standing requirements the members of this Project wrote for it. Follow them in every reply here; where they conflict with a memory entry, these win.\n\n" +
    "<project_instructions>\n" + text + "\n</project_instructions>"
  );
}

/**
 * Everything one request carried apart from its system prompt, as text.
 * @param prompt - What one model call was handed.
 * @returns The other messages, serialised.
 */
function outsideSystem(prompt: readonly unknown[] | undefined): string {
  return JSON.stringify((prompt ?? []).filter((m) => (m as { role?: string }).role !== "system"));
}

/**
 * Whether a request replayed an earlier reply with its thinking.
 * @param prompt - What one model call was handed.
 * @returns True when an assistant message carries a reasoning part.
 */
function replaysThinking(prompt: readonly unknown[] | undefined): boolean {
  return (prompt ?? []).some((m) => {
    const message = m as { role?: string; content?: unknown };
    return message.role === "assistant" && Array.isArray(message.content) &&
      (message.content as Array<{ type: string }>).some((part) => part.type === "reasoning");
  });
}

/**
 * Run a first turn that thinks before it answers, read back what it stored,
 * and make that the conversation the next turn reads.
 * @param text - The Project Instructions during the first turn.
 * @throws {never} Never.
 */
async function firstTurnThatThinks(text: string | undefined): Promise<void> {
  world.projectInstructions = text;
  world.script = [thinksThenAnswers("first answer")];
  await sendMessage("first");
  world.history = rowsOf(1);
  world.controller = new AbortController();
}

describe("a turn in a Project with instructions", () => {
  it("ends the system prompt with them, and leaves them out of the user's message and the copy kept of it", async () => {
    world.projectInstructions = WRITTEN;
    world.script = [answers("ok")];

    await sendMessage("hi");

    expect(systemOf(world.prompts[0]).endsWith(section(WRITTEN))).toBe(true);
    expect(outsideSystem(world.prompts[0])).not.toContain("PALETTE-BLUE-AND-WHITE");
    expect(world.userForModel.length).toBeGreaterThan(0);
    expect(JSON.stringify(world.userForModel)).not.toContain("PALETTE-BLUE-AND-WHITE");
    expect(JSON.stringify(world.userMessages)).not.toContain("PALETTE-BLUE-AND-WHITE");
  });

  it("sends them once on the next turn, in the system prompt only, and the earlier reply keeps its thinking while they are unchanged", async () => {
    await firstTurnThatThinks(WRITTEN);
    world.script = [answers("second answer")];

    await sendMessage("second");

    const second = world.prompts[1];
    expect(systemOf(second).endsWith(section(WRITTEN))).toBe(true);
    expect(JSON.stringify(second).split("PALETTE-BLUE-AND-WHITE")).toHaveLength(2);
    expect(outsideSystem(second)).not.toContain("PALETTE-BLUE-AND-WHITE");
    expect(outsideSystem(second)).toContain("first answer");
    expect(replaysThinking(second)).toBe(true);
  });

  it("sends the changed text on the next turn, and the reply written before the change goes back without its thinking", async () => {
    await firstTurnThatThinks(WRITTEN);
    world.projectInstructions = REWRITTEN;
    world.script = [answers("second answer")];

    await sendMessage("second");

    const second = world.prompts[1];
    expect(systemOf(world.prompts[0]).endsWith(section(WRITTEN))).toBe(true);
    expect(systemOf(second).endsWith(section(REWRITTEN))).toBe(true);
    expect(JSON.stringify(second)).not.toContain("PALETTE-BLUE-AND-WHITE");
    expect(replaysThinking(second)).toBe(false);
  });

  it("sends no section once they are cleared", async () => {
    await firstTurnThatThinks(WRITTEN);
    world.projectInstructions = undefined;
    world.script = [answers("second answer")];

    await sendMessage("second");

    expect(systemOf(world.prompts[0]).endsWith(section(WRITTEN))).toBe(true);
    expect(systemOf(world.prompts[1])).not.toContain("## Project Instructions");
    expect(JSON.stringify(world.prompts[1])).not.toContain("PALETTE-BLUE-AND-WHITE");
  });

  it("sends the text written when a questionnaire is answered, not the one the turn asked under", async () => {
    world.projectInstructions = WRITTEN;
    world.script = [asks("ask-1", 100, 10, true)];
    await sendMessage("make me a poster");
    const rows = rowsOf(1);
    const reply = rows.find((row) => row.role === "assistant");
    if (reply === undefined) throw new Error("the turn stored no reply");
    (reply.forModel as { messages: ModelMessage[] }).messages.push(askResultForModel("ask-1", { answers: [] }));
    reply.parts = reply.parts.map((part) =>
      part.type === "tool" && part.toolCallId === "ask-1" ? { ...part, status: "success", output: { answers: [] } } : part,
    );
    world.history = rows;
    world.controller = new AbortController();
    world.projectInstructions = REWRITTEN;
    world.script = [answers("the poster plan")];

    await sendAnswer("ask-1", 1);

    expect(systemOf(world.prompts[0]).endsWith(section(WRITTEN))).toBe(true);
    const resumed = world.prompts.at(-1);
    expect(world.prompts).toHaveLength(2);
    expect(systemOf(resumed).endsWith(section(REWRITTEN))).toBe(true);
    expect(JSON.stringify(resumed)).not.toContain("PALETTE-BLUE-AND-WHITE");
  });
});

describe("a turn that folds its memory still ends every request after the reassembly with the instructions", () => {
  it("when it folds before its first call", async () => {
    world.window = WINDOW;
    world.projectInstructions = WRITTEN;
    world.script = [answers("first answer", LINE - 616, 616)];
    await sendMessage("first");
    world.history = rowsOf(1);
    world.controller = new AbortController();
    const promptsBefore = world.prompts.length;
    world.script = [answers("second answer")];

    await sendMessage("second");

    const sent = world.prompts.slice(promptsBefore);
    expect(world.folds).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(0);
    for (const prompt of sent) {
      expect(systemOf(prompt)).toContain("MEMORY-THROUGH-1");
      expect(systemOf(prompt).endsWith(section(WRITTEN))).toBe(true);
    }
  });

  it("when it folds between two steps", async () => {
    world.window = WINDOW;
    world.history = [...plainTurn(1, 10_000), ...plainTurn(2, 10_000), ...plainTurn(3, 10_000)];
    world.nextTurn = 4;
    world.projectInstructions = WRITTEN;
    world.script = [callsFetch("c1", LINE - 600, 600), answers("done")];

    await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "tool", "fold", "call"]);
    expect(systemOf(world.prompts[0]).endsWith(section(WRITTEN))).toBe(true);
    expect(systemOf(world.prompts[1])).toContain("MEMORY-THROUGH-1");
    expect(systemOf(world.prompts[1]).endsWith(section(WRITTEN))).toBe(true);
  });

  it("when the first call is turned away as too long", async () => {
    world.history = [...plainTurn(1, 30_000), ...plainTurn(2, 30_000)];
    world.nextTurn = 3;
    world.projectInstructions = WRITTEN;
    world.script = [{ reject: h1() }, answers("the answer")];

    await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "fold", "call"]);
    expect(systemOf(world.prompts[1])).toContain("MEMORY-THROUGH-1");
    expect(systemOf(world.prompts[1]).endsWith(section(WRITTEN))).toBe(true);
  });
});
