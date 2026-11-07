// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The three memory tools (#1363): the Agent saves, deletes and reads its own
 * memory entries in the turn the reader asks.
 *
 * The writes and reads are the server's, bound to the turn's user, Project
 * and conversation and handed in through the tool context as `AgentMemory`;
 * these cases stand in for it and check what each tool asks for, what it
 * writes back for the model, and how each refusal reads.
 */
import { describe, it, expect, vi } from "vitest";
import type { Tool } from "ai";
import { toolFailureOf } from "@breatic/shared";
import { TOOL_MAP, BASELINE_TOOLS } from "@domain/agent/tools/index.js";
import { MemoryRefused, type AgentMemory, type MemoryEntry } from "@domain/agent/memory-entries.js";

const SAVE = "save_memory";
const DELETE = "delete_memory";
const READ = "read_memory";

const ENTRY_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";

/**
 * One entry as the server answers it.
 * @param over - The fields a case sets.
 * @returns The entry.
 */
function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: ENTRY_ID,
    scope: "project",
    title: "Lead character: Lin Wu",
    content: "Tear mole under the left eye; dark green trench coat.",
    origin: "agent",
    sourceConversationId: CONVERSATION,
    updatedAt: "2026-11-05T08:00:00.000Z",
    ...over,
  };
}

/**
 * Memory that answers nothing until a case says otherwise.
 * @param over - The calls a case answers.
 * @returns The memory.
 */
function memory(over: Partial<AgentMemory> = {}): AgentMemory {
  return {
    save: vi.fn().mockResolvedValue(entry()),
    remove: vi.fn().mockResolvedValue(entry()),
    read: vi.fn().mockResolvedValue([]),
    search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    ...over,
  };
}

/**
 * The registered tool.
 * @param name - Its name.
 * @returns The tool.
 * @throws {Error} When it is not registered.
 */
function toolNamed(name: string): Tool {
  const build = TOOL_MAP[name];
  if (!build) throw new Error(`${name} is not registered`);
  return build();
}

/**
 * Call one of the memory tools as a turn would.
 * @param name - The tool.
 * @param input - What the model sent.
 * @param mem - The turn's memory.
 * @returns What the tool answered.
 * @throws {Error} When the tool has no execute, or when the call fails.
 */
async function call(name: string, input: Record<string, unknown>, mem: AgentMemory): Promise<string> {
  const tool = toolNamed(name);
  if (!tool.execute) throw new Error(`${name} has no execute`);
  const answer: unknown = await tool.execute(input, { toolCallId: "t1", messages: [], context: { memory: mem } } as never);
  if (typeof answer !== "string") throw new Error(`${name} answered with ${typeof answer}`);
  return answer;
}

/**
 * What a failed call carries.
 * @param pending - The call.
 * @returns Its failure.
 * @throws {Error} When the call succeeded.
 */
async function failureOf(pending: Promise<unknown>): Promise<ReturnType<typeof toolFailureOf>> {
  const err = await pending.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (e: unknown) => e,
  );
  return toolFailureOf(err);
}

/**
 * Whether the tool's input schema takes this input.
 * @param name - The tool.
 * @param input - What the model would send.
 * @returns True when it parses.
 */
function accepts(name: string, input: Record<string, unknown>): boolean {
  const schema = toolNamed(name).inputSchema as { safeParse: (v: unknown) => { success: boolean } };
  return schema.safeParse(input).success;
}

describe("the memory tools", () => {
  it("are offered on every turn, whatever is open", () => {
    for (const name of [SAVE, DELETE, READ]) {
      expect(TOOL_MAP).toHaveProperty(name);
      expect(BASELINE_TOOLS).toContain(name);
    }
  });

  it("each say in words what is happening while they run", () => {
    const lines = Object.fromEntries(
      [SAVE, DELETE, READ].map((name) => [name, (toolNamed(name).metadata as { runningLine?: string } | undefined)?.runningLine]),
    );
    expect(lines).toEqual({
      [SAVE]: "chat.tool.savingMemory",
      [DELETE]: "chat.tool.deletingMemory",
      [READ]: "chat.tool.readingMemory",
    });
  });
});

describe("save_memory", () => {
  it("adds an entry when no id is given and says what it recorded", async () => {
    const mem = memory({ save: vi.fn().mockResolvedValue(entry({ title: "All videos 9:16" })) });

    const answer = await call(SAVE, { scope: "project", title: "All videos 9:16", content: "Every clip at most 8 seconds." }, mem);

    expect(mem.save).toHaveBeenCalledWith({ scope: "project", title: "All videos 9:16", content: "Every clip at most 8 seconds." });
    expect(answer).toBe(`Saved ${ENTRY_ID}: All videos 9:16`);
  });

  it("replaces the entry it names", async () => {
    const mem = memory();

    await call(SAVE, { id: ENTRY_ID, scope: "conversation", title: "Lead character: Lin Wu", content: "Now in a red coat." }, mem);

    expect(mem.save).toHaveBeenCalledWith({
      id: ENTRY_ID,
      scope: "conversation",
      title: "Lead character: Lin Wu",
      content: "Now in a red coat.",
    });
  });

  it.each([
    ["a title over 120 characters", { scope: "project", title: "t".repeat(121), content: "c" }],
    ["an empty title", { scope: "project", title: "  ", content: "c" }],
    ["a title over two lines", { scope: "project", title: "Lead\ncharacter", content: "c" }],
    ["content over 4000 characters", { scope: "project", title: "t", content: "c".repeat(4001) }],
    ["empty content", { scope: "project", title: "t", content: "" }],
    ["a scope that is neither", { scope: "studio", title: "t", content: "c" }],
    ["an id that is not one", { id: "lin-wu", scope: "project", title: "t", content: "c" }],
  ])("refuses %s", (_label, input) => {
    expect(accepts(SAVE, input)).toBe(false);
  });

  it("counts the limits in characters, so a title of 120 emoji fits", () => {
    expect(accepts(SAVE, { scope: "project", title: "🧥".repeat(120), content: "c" })).toBe(true);
  });

  it("says the entry it was asked to replace is not this user's in this Project", async () => {
    const mem = memory({ save: vi.fn().mockRejectedValue(new MemoryRefused("unknown_entry", OTHER_ID)) });

    const failure = await failureOf(call(SAVE, { id: OTHER_ID, scope: "project", title: "t", content: "c" }, mem));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure?.forModel).toContain(OTHER_ID);
    expect(failure?.forModel).toMatch(/not .*this user's memory in this Project/i);
  });
});

describe("delete_memory", () => {
  it("removes the entry it names and says which one", async () => {
    const mem = memory();

    const answer = await call(DELETE, { id: ENTRY_ID }, mem);

    expect(mem.remove).toHaveBeenCalledWith(ENTRY_ID);
    expect(answer).toBe(`Deleted ${ENTRY_ID}: Lead character: Lin Wu`);
  });

  it("says when the entry was already deleted", async () => {
    const mem = memory({ remove: vi.fn().mockRejectedValue(new MemoryRefused("deleted", ENTRY_ID)) });

    const failure = await failureOf(call(DELETE, { id: ENTRY_ID }, mem));

    expect(failure).toMatchObject({ kind: "turned_away" });
    expect(failure?.forModel).toContain(ENTRY_ID);
    expect(failure?.forModel).toMatch(/already deleted/i);
  });
});

describe("read_memory", () => {
  it("reads the entries it names in full", async () => {
    const mem = memory({
      read: vi.fn().mockResolvedValue([entry(), entry({ id: OTHER_ID, scope: "conversation", title: "Palette", content: "Teal and orange.", sourceConversationId: null })]),
    });

    const answer = await call(READ, { ids: [ENTRY_ID, OTHER_ID] }, mem);

    expect(mem.read).toHaveBeenCalledWith([ENTRY_ID, OTHER_ID]);
    expect(answer).toContain(ENTRY_ID);
    expect(answer).toContain("Tear mole under the left eye; dark green trench coat.");
    expect(answer).toContain(OTHER_ID);
    expect(answer).toContain("Teal and orange.");
    expect(answer).toContain("2026-11-05T08:00:00.000Z");
    expect(answer).toContain(CONVERSATION);
  });

  it("finds entries by words and says how to read the next page", async () => {
    const mem = memory({ search: vi.fn().mockResolvedValue({ items: [entry()], nextCursor: "c2" }) });

    const answer = await call(READ, { query: "Lin Wu" }, mem);

    expect(mem.search).toHaveBeenCalledWith("Lin Wu", undefined);
    expect(answer).toContain("Lead character: Lin Wu");
    expect(answer).toContain("cursor=c2");
  });

  it("says when no entry holds the words", async () => {
    const answer = await call(READ, { query: "neon" }, memory());

    expect(answer).toMatch(/no entry/i);
  });

  it.each([
    ["neither ids nor a query", {}],
    ["both", { ids: [ENTRY_ID], query: "Lin" }],
    ["no ids", { ids: [] }],
    ["more than 20 ids", { ids: Array.from({ length: 21 }, () => ENTRY_ID) }],
  ])("refuses %s", (_label, input) => {
    expect(accepts(READ, input)).toBe(false);
  });

  it("tells the reader they are no longer a member when the server says so", async () => {
    const mem = memory({ read: vi.fn().mockRejectedValue(new MemoryRefused("not_member")) });

    expect(await failureOf(call(READ, { ids: [ENTRY_ID] }, mem))).toMatchObject({
      kind: "tool_failed",
      readerKey: "chat.tool.failure.notMember",
    });
  });

  it("says the fault is ours when the read itself fails", async () => {
    const mem = memory({ read: vi.fn().mockRejectedValue(new Error("connection reset")) });

    expect(await failureOf(call(READ, { ids: [ENTRY_ID] }, mem))).toMatchObject({
      kind: "tool_failed",
      readerKey: "chat.tool.failure.ourFault",
    });
  });
});

describe("what the memory tools' descriptions say", () => {
  it("say what goes in and what comes back, and leave when to call them to the system prompt", () => {
    for (const name of [SAVE, DELETE, READ]) {
      const description = String(toolNamed(name).description).replace(/\s+/g, " ");
      expect(description).not.toMatch(/when the (user|reader) asks/i);
    }
  });
});
