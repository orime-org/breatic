// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /api/v1/mini-tools/text` and `GET /api/v1/mini-tools/text/config`
 * (inner#1860): the contract, who may call it, the budgets, the stream framing,
 * the model call and the billing.
 *
 * The real route and the real text-tool service run here; only the model,
 * the credit engine and the infrastructure are doubles. Billing is asserted
 * at the HTTP entry so the assertions hold whichever way the route and the
 * service split the work between them.
 *
 * The config directory is a copy of the shipped one with the two budgets made
 * small, so a test can cross them with a short string; the model and thinking
 * level stay what `config/text-tools.yaml` ships.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";

vi.mock("ai", () => ({
  tool: (c: Record<string, unknown>) => c,
  streamText: vi.fn(), generateText: vi.fn(), stepCountIs: vi.fn(),
}));

/** Budgets written into this suite's copy of `config/text-tools.yaml`. */
const BUDGET = vi.hoisted(() => ({ selection: 40, context: 120 }));

/** Where the shipped repository lives, for the locale files. */
const roots = vi.hoisted(() => ({ real: "" }));

/** Keys the Redis double holds, cleared between cases. */
const redisKeys = vi.hoisted(() => new Map<string, string>());

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const { cpSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { parse, stringify } = await import("yaml");
  const real = base.MONOREPO_ROOT as string;
  roots.real = real;
  const root = mkdtempSync(join(tmpdir(), "text-tools-route-"));
  cpSync(join(real, "config"), join(root, "config"), { recursive: true });
  const file = join(root, "config", "text-tools.yaml");
  const shipped = parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    file,
    stringify({ ...shipped, selection_max_chars: BUDGET.selection, context_max_chars: BUDGET.context }),
  );
  // A Redis whose `SET ... NX` behaves like Redis, so a per-user lock (if one
  // is still taken) really refuses a second holder.
  const shared = (base.getRedis as () => Record<string, unknown>)();
  const held = redisKeys;
  const redis = {
    ...shared,
    set: async (key: string, value: string, ...args: unknown[]): Promise<string | null> => {
      if (args.includes("NX") && held.has(key)) return null;
      held.set(key, value);
      return "OK";
    },
    del: async (key: string): Promise<number> => (held.delete(key) ? 1 : 0),
  };
  return { ...base, MONOREPO_ROOT: root, getRedis: () => redis };
});

/** What the fake model streams, and what it was asked. */
const model = vi.hoisted(() => ({
  deltas: ["ok"] as string[],
  /** Held until released, so several runs can be in flight at once. */
  gate: null as Promise<void> | null,
  entered: 0,
  calls: [] as Record<string, unknown>[],
}));

vi.mock("@breatic/domain", async () => {
  const { domainMock } = await import("../helpers/mock-core.js");
  return {
    ...domainMock(),
    streamTextRetry: (opts: Record<string, unknown>) => {
      model.calls.push(opts);
      model.entered += 1;
      const ended = opts.onLanguageModelCallEnd as
        | ((event: Record<string, unknown>) => void)
        | undefined;
      return {
        fullStream: (async function* () {
          if (model.gate) await model.gate;
          ended?.({
            responseId: "gen-test",
            usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
            providerMetadata: { openrouter: { usage: { cost: 0.01 } } },
          });
          for (const text of model.deltas) yield { type: "text-delta", text };
        })(),
      };
    },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const { serverModulesMock } = await import("../helpers/mock-core.js");
  const actual = await importOriginal<Record<string, unknown>>();
  // The real service: billing and the model call are what this suite is about.
  return { ...(await serverModulesMock(async () => actual)), textToolService: actual.textToolService };
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, ForbiddenError } from "@breatic/core";
import { callOptionsFor, getModel } from "@breatic/domain";
import { parse } from "yaml";
import { createApp } from "../../app.js";
import { mocks } from "../helpers/mock-core.js";

const AUTH = { Cookie: "breatic_session=valid-token", "Content-Type": "application/json" };
const PID = "11111111-1111-4111-8111-111111111111";
const DOC = "# Notes\n\nThe **quick** brown fox jumps.\n\n- one\n- two";
const SEL = "The **quick** brown fox jumps.";

/** A valid body for every tool, without the project. */
const BODIES: Record<string, Record<string, unknown>> = {
  polish: { tool: "polish", document: DOC, selection: SEL },
  expand: { tool: "expand", document: DOC, selection: SEL },
  shorten: { tool: "shorten", document: DOC, selection: SEL },
  summarize: { tool: "summarize", document: DOC, selection: SEL },
  continue: { tool: "continue", document: DOC, selection: SEL },
  translate: { tool: "translate", document: DOC, selection: SEL, language: "ja" },
  rewrite: { tool: "rewrite", document: DOC, selection: SEL, style: "confident" },
  custom: { tool: "custom", document: DOC, selection: SEL, instructions: "Turn it into a haiku" },
  generate: { tool: "generate", instructions: "write a line" },
  character: { tool: "character", name: "Ada" },
  storyboard: { tool: "storyboard", instructions: "a chase" },
  script: { tool: "script", scene_description: "a chase" },
};

/** The six commands of the document AI menu. */
const DOCUMENT_TOOLS = ["polish", "expand", "shorten", "translate", "rewrite", "custom"] as const;

/** One parsed server-sent event. */
interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parse a body the way an EventSource does: events end at a blank line, each
 * `data:` line is one line of the event's data.
 * @param body - The raw response text.
 * @returns The events, in order.
 */
function parseSse(body: string): SseEvent[] {
  return body
    .split(/\r\n\r\n|\n\n|\r\r/)
    .filter((block) => block.trim() !== "")
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      return { event, data: data.join("\n") };
    });
}

/**
 * Read one `text_delta` event's data as the new framing writes it.
 * @param data - The event's data.
 * @returns The parsed object, or the raw data when it is not JSON.
 */
function deltaOf(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return { notJson: data };
  }
}

/**
 * Send one text-tool request.
 * @param body - The JSON body.
 * @param headers - Extra headers.
 * @returns The response.
 */
async function post(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return createApp().request("/api/v1/mini-tools/text", {
    method: "POST",
    headers: { ...AUTH, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A tool's valid body, in the project.
 * @param tool - The tool.
 * @param extra - Fields to add or override.
 * @returns The body.
 */
function bodyFor(tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BODIES[tool], project_id: PID, ...extra };
}

/**
 * Send a request and read its whole stream.
 * @param body - The JSON body.
 * @param headers - Extra headers.
 * @returns The status and the events.
 */
async function run(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; events: SseEvent[] }> {
  const res = await post(body, headers);
  return { status: res.status, events: parseSse(await res.text()) };
}

/**
 * Every log line with this message, at any level.
 * @param message - The log message.
 * @returns The context objects it was logged with.
 */
function logged(message: string): Record<string, unknown>[] {
  return [mocks.logger.info, mocks.logger.warn, mocks.logger.error]
    .flatMap((fn) => fn.mock.calls as unknown[][])
    .filter((call) => call[1] === message)
    .map((call) => call[0] as Record<string, unknown>);
}

/**
 * What the model was sent, as one searchable string.
 * @param call - The options `streamTextRetry` received.
 * @returns The system prompt and messages, serialised.
 */
function promptOf(call: Record<string, unknown> | undefined): string {
  return JSON.stringify({ system: call?.system, messages: call?.messages });
}

/** Operation keys every charge in this test was made under. */
function chargedKeys(): string[] {
  return mocks.creditLotService.chargeOnceForGeneration.mock.calls.map((call: unknown[]) => call[0] as string);
}

/** The pattern the shipped same-language instruction is written in. */
const SAME_LANGUAGE = /same language as the user's input|match the input language/i;

beforeEach(() => {
  vi.clearAllMocks();
  // A stream an earlier case left unread must not hold anything into this one.
  redisKeys.clear();
  // A once-answer a case queued and today's route never consumed must not
  // reach the next case.
  mocks.projectService.assertAccess.mockReset().mockResolvedValue(undefined);
  mocks.creditLotService.getSpendableCredits.mockReset().mockResolvedValue("100.000000");
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true });
  vi.mocked(callOptionsFor).mockReset().mockReturnValue({ providerOptions: {} });
  model.deltas = ["ok"];
  model.gate = null;
  model.entered = 0;
  model.calls = [];
});

describe("the contract", () => {
  it("requires auth", async () => {
    const res = await createApp().request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyFor("polish")),
    });

    expect(res.status).toBe(401);
  });

  it("rejects an unknown tool with 422", async () => {
    const res = await post({ tool: "nonexistent-tool", document: "hello", project_id: PID });

    expect(res.status).toBe(422);
  });

  it.each(Object.keys(BODIES))("accepts %s with a project and refuses it without one", async (tool) => {
    const withProject = await post(bodyFor(tool));
    await withProject.text();
    const { project_id: _dropped, ...withoutProject } = bodyFor(tool);
    const refused = await post(withoutProject);

    expect(withProject.status).toBe(200);
    expect(refused.status).toBe(422);
  });

  it("refuses an empty selection", async () => {
    const res = await post(bodyFor("polish", { selection: "" }));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it.each(["en", "zh-CN", "zh-TW", "ja", "ko"])("translates into %s", async (language) => {
    const res = await post(bodyFor("translate", { language }));
    await res.text();

    expect(res.status).toBe(200);
  });

  it.each(["fr", "Japanese", "", "zh"])("refuses translating into %j", async (language) => {
    const res = await post(bodyFor("translate", { language }));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it.each(["professional", "casual", "straightforward", "confident", "friendly"])(
    "rewrites in the %s tone and tells the model which",
    async (style) => {
      const { status } = await run(bodyFor("rewrite", { style }));

      expect(status).toBe(200);
      expect(promptOf(model.calls[0])).toContain(style);
    },
  );

  it.each(["pirate", "formal", ""])("refuses the tone %j", async (style) => {
    const res = await post(bodyFor("rewrite", { style }));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it("runs custom with instructions and refuses it with none or empty ones", async () => {
    const accepted = await post(bodyFor("custom"));
    await accepted.text();
    const { instructions: _dropped, ...withoutInstructions } = bodyFor("custom");
    const missing = await post(withoutInstructions);
    const empty = await post(bodyFor("custom", { instructions: "" }));

    expect(accepted.status).toBe(200);
    expect(missing.status).toBe(422);
    expect(empty.status).toBe(422);
  });

  it("runs shorten", async () => {
    const { status, events } = await run(bodyFor("shorten"));

    expect(status).toBe(200);
    expect(events.at(-1)?.event).toBe("done");
  });
});

describe("who may call it", () => {
  it("streams for an editor of the project", async () => {
    const res = await post(bodyFor("polish"));
    const events = parseSse(await res.text());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(mocks.projectService.assertAccess).toHaveBeenCalledWith(PID, "user-1", "editor");
    expect(events.at(-1)?.event).toBe("done");
  });

  it("answers 404 to someone who is not a member, runs nothing and logs the refusal", async () => {
    mocks.projectService.assertAccess.mockRejectedValueOnce(new NotFoundError("not found"));

    const res = await post(bodyFor("polish"));

    expect(res.status).toBe(404);
    expect(model.calls).toHaveLength(0);
    expect(mocks.creditLotService.chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(logged("text_tool_forbidden")).toEqual([
      expect.objectContaining({ userId: "user-1", projectId: PID }),
    ]);
  });

  it("answers 403 to a viewer, runs nothing and logs the refusal", async () => {
    mocks.projectService.assertAccess.mockRejectedValueOnce(new ForbiddenError("forbidden"));

    const res = await post(bodyFor("translate"));

    expect(res.status).toBe(403);
    expect(model.calls).toHaveLength(0);
    expect(mocks.creditLotService.chargeOnceForGeneration).not.toHaveBeenCalled();
    expect(logged("text_tool_forbidden")).toEqual([
      expect.objectContaining({ userId: "user-1", projectId: PID }),
    ]);
  });

  it("answers 402 when the project's studio cannot cover the smallest credit, before the model runs", async () => {
    mocks.creditLotService.getSpendableCredits.mockResolvedValueOnce("0.000000");

    const res = await post(bodyFor("polish"));

    expect(res.status).toBe(402);
    expect(mocks.assetService.resolveOwnerStudioId).toHaveBeenCalledWith(PID);
    expect(model.calls).toHaveLength(0);
  });

  it("is rate limited per user under the text-tool action", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 17 });

    const res = await post(bodyFor("polish"));

    expect(res.status).toBe(429);
    const quotas = mocks.checkRateLimit.mock.calls.at(-1)?.[1] as { key: string }[] | undefined;
    expect(quotas?.map((q) => q.key)).toContain("text-tool:user-1");
    expect(model.calls).toHaveLength(0);
  });
});

describe("the budgets in config/text-tools.yaml", () => {
  it("refuses a selection one character over selection_max_chars with 422", async () => {
    const selection = "s".repeat(BUDGET.selection + 1);

    const res = await post(bodyFor("polish", { selection, document: selection }));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it.each([
    ["polish", { instructions: "i".repeat(BUDGET.selection + BUDGET.context + 2000 + 1) }],
    ["generate", { instructions: "i".repeat(BUDGET.selection + BUDGET.context + 2000 + 1) }],
    ["character", { name: "Ada", context: "c".repeat(BUDGET.selection + BUDGET.context + 2000 + 1) }],
  ])("refuses a %s request whose words add up past both budgets and the longest instruction, whichever field holds them", async (tool, extra) => {
    const res = await post(bodyFor(tool, extra));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it.each([
    ["custom", { selection: "s".repeat(BUDGET.selection), document: `${"s".repeat(BUDGET.selection)}${"d".repeat(BUDGET.context - BUDGET.selection)}`, instructions: "i".repeat(2000) }],
    ["translate", { selection: "s".repeat(BUDGET.selection), document: `${"s".repeat(BUDGET.selection)}${"d".repeat(BUDGET.context - BUDGET.selection)}`, language: "zh-CN" }],
  ])("accepts a %s request with every part at its own limit", async (tool, extra) => {
    const res = await post(bodyFor(tool, extra));

    expect(res.status).toBe(200);
  });

  it("refuses a document one character over context_max_chars with 422", async () => {
    const document = `${SEL}${"d".repeat(BUDGET.context + 1 - SEL.length)}`;

    const res = await post(bodyFor("polish", { document }));

    expect(res.status).toBe(422);
    expect(model.calls).toHaveLength(0);
  });

  it("runs a selection and a document exactly at their budgets", async () => {
    const selection = "s".repeat(BUDGET.selection);
    const document = `${selection}${"d".repeat(BUDGET.context - BUDGET.selection)}`;

    const { status, events } = await run(bodyFor("polish", { selection, document }));

    expect(status).toBe(200);
    expect(events.at(-1)?.event).toBe("done");
  });

  it("hands the browser both budgets", async () => {
    const res = await createApp().request("/api/v1/mini-tools/text/config", { headers: AUTH });

    expect(res.status).toBe(200);
    const shipped = parse(readFileSync(join(roots.real, "config", "text-tools.yaml"), "utf-8")) as Record<string, unknown>;
    expect(typeof shipped.reveal_chars_per_second).toBe("number");
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      selectionMaxChars: BUDGET.selection,
      contextMaxChars: BUDGET.context,
      revealCharsPerSecond: shipped.reveal_chars_per_second,
    });
  });
});

describe("the stream framing", () => {
  it("sends each text_delta as JSON so newlines inside it survive the frame", async () => {
    model.deltas = ["line one\n\nline two\n", "data: not a field\r\n", "\n- item\n", "end"];

    const { events } = await run(bodyFor("polish"));

    const deltas = events.filter((e) => e.event === "text_delta").map((e) => deltaOf(e.data));
    expect(deltas).toEqual(model.deltas.map((text) => ({ text })));
    expect(events.at(-1)?.event).toBe("done");
  });
});

describe("the model call", () => {
  it("uses the configured model at the configured thinking level and sends no temperature", async () => {
    vi.mocked(callOptionsFor).mockReturnValueOnce({ providerOptions: { marker: { from: "callOptionsFor" } } });

    await run(bodyFor("polish"));

    expect(vi.mocked(getModel)).toHaveBeenCalledWith("google/gemini-3.8-flash");
    expect(vi.mocked(callOptionsFor)).toHaveBeenCalledWith(
      "google/gemini-3.8-flash",
      expect.objectContaining({ thinkingLevel: "low" }),
    );
    expect(model.calls[0]?.providerOptions).toEqual({ marker: { from: "callOptionsFor" } });
    expect(model.calls[0]).not.toHaveProperty("temperature");
  });

  it("streams the model's text as it comes: the reader's screen paces it", async () => {
    await run(bodyFor("polish"));

    expect(model.calls[0]).not.toHaveProperty("experimental_transform");
  });

  it.each([
    ["en", "English"],
    ["zh-CN", "Simplified Chinese"],
    ["zh-TW", "Traditional Chinese"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
  ])("asks for a translation into %s by name, without the same-language instruction", async (language, name) => {
    await run(bodyFor("translate", { language }));

    const prompt = promptOf(model.calls[0]);
    expect(prompt).toContain(name);
    expect(prompt).not.toMatch(SAME_LANGUAGE);
  });

  it("lets custom follow the user's own request, language included", async () => {
    const instructions = "Answer in French, as a haiku";

    await run(bodyFor("custom", { instructions }));

    const prompt = promptOf(model.calls[0]);
    expect(prompt).toContain(instructions);
    expect(prompt).toContain("quick");
    expect(prompt).toContain("Notes");
    expect(prompt).not.toMatch(SAME_LANGUAGE);
  });

  it.each(DOCUMENT_TOOLS)("tells the model the %s selection is Markdown", async (tool) => {
    await run(bodyFor(tool));

    expect(String(model.calls[0]?.system)).toMatch(/markdown/i);
  });

  it("gives shorten its own prompt rather than summarize's", async () => {
    await run(bodyFor("shorten"));
    await run(bodyFor("summarize"));

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.system).not.toEqual(model.calls[1]?.system);
  });
});

describe("billing", () => {
  it("charges the project under an operation key the server minted, not the client's Idempotency-Key", async () => {
    await run(bodyFor("polish"), { "Idempotency-Key": "client-key-1" });

    const charge = vi.mocked(mocks.creditLotService.chargeOnceForGeneration).mock.calls[0];
    expect(charge?.[0]).toMatch(/^texttool:/);
    expect(charge?.[0]).not.toContain("client-key-1");
    expect(charge?.[1]).toMatchObject({ projectId: PID, actorUserId: "user-1" });
  });

  it("records usage against the project under the key it charges under", async () => {
    const { createUsageRecorder } = await import("@breatic/domain");

    await run(bodyFor("polish"), { "Idempotency-Key": "client-key-2" });

    const opened = vi.mocked(createUsageRecorder).mock.calls[0]?.[0] as { operationKey: string; projectId: string | null };
    expect(opened.projectId).toBe(PID);
    expect(opened.operationKey).not.toContain("client-key-2");
    expect(chargedKeys()).toEqual([opened.operationKey]);
  });

  it("charges the same Idempotency-Key sent twice twice", async () => {
    await run(bodyFor("polish"), { "Idempotency-Key": "same-key" });
    await run(bodyFor("polish"), { "Idempotency-Key": "same-key" });

    const keys = chargedKeys();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("runs two concurrent requests from one user to the end and charges each", async () => {
    let release: () => void = () => {};
    model.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = post(bodyFor("polish"));
    const second = post(bodyFor("expand"));
    const responses = await Promise.all([first, second]);
    // Both are now open; let the model answer them.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const runs = await Promise.all(responses.map(async (res) => parseSse(await res.text())));

    expect(runs.map((events) => events.at(-1)?.event)).toEqual(["done", "done"]);
    expect(runs.flat().some((e) => e.data.includes("already running"))).toBe(false);
    expect(model.entered).toBe(2);
    const keys = chargedKeys();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("holds for any number of overlapping runs and any client keys: each finishes and is charged once, to the project, under its own server key", async () => {
    const clientKey = fc.stringMatching(/^[A-Za-z0-9_:.-]{1,24}$/);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.option(clientKey, { nil: undefined }), { minLength: 1, maxLength: 5 }),
        async (keys) => {
          vi.clearAllMocks();
          model.calls = [];
          model.entered = 0;
          let release: () => void = () => {};
          model.gate = new Promise<void>((resolve) => {
            release = resolve;
          });

          const responses = await Promise.all(
            keys.map((key) => post(bodyFor("polish"), key === undefined ? {} : { "Idempotency-Key": key })),
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
          release();
          const runs = await Promise.all(responses.map(async (res) => parseSse(await res.text())));
          model.gate = null;

          // Every request runs to the end.
          expect(runs.map((events) => events.at(-1)?.event)).toEqual(keys.map(() => "done"));
          // Every run is charged exactly once, under a key of its own.
          const charges = vi.mocked(mocks.creditLotService.chargeOnceForGeneration).mock.calls;
          const charged = charges.map((call: unknown[]) => call[0] as string);
          expect(charged).toHaveLength(keys.length);
          expect(new Set(charged).size).toBe(keys.length);
          // No client key reaches a charge.
          for (const key of keys) {
            if (key !== undefined) expect(charged.some((k) => k === `texttool:${key}`)).toBe(false);
          }
          // Every charge is to this project.
          for (const call of charges) expect(call[1]).toMatchObject({ projectId: PID });
        },
      ),
      { numRuns: 15 },
    );
  });

  it("no longer ships the already-running message in any locale", () => {
    const dir = join(roots.real, "locales");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const catalog = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
        server?: { text_tool?: Record<string, unknown> };
      };
      expect(catalog.server?.text_tool?.already_running, file).toBeUndefined();
    }
  });
});
