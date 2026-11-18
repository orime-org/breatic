// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaBinding, ProviderConfigInput } from "../../config/schema.js";
import type { Cost } from "../../cost.js";
import { SendNotAccepted, UpstreamRequestRejected } from "../../errors.js";
import type { KeySet } from "../../index.js";
import { createProvider, type Provider } from "../../provider.js";
import { accountKeys, deploymentKeyOf, keyFailureOf, malformedKeyArb, printableKeyArb, settled, textOf } from "../../__tests__/keys-harness.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billing, fakeUpstream, result, type FakeUpstream, type Reply } from "./fake-upstream.js";

// A media run on the key set the caller hands each call (inner#1953): an account's keys are the only ones its run may
// use, the ticket records whose keys each step ran on and never a key, every cost says who paid it, and a failure of an
// account's key is told apart from every other failure without moving to another upstream or to the deployment's key.

// The loopback image server stands in for a public host.
vi.mock("../../http/private-address.js", () => ({ reachable: () => Promise.resolve(true) }));

const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
const DEPLOYMENT = { WAVESPEED_API_KEY: "dep-ws", FAL_KEY: "dep-fal", SANDBASE_API_KEY: "dep-sb", OPENROUTER_API_KEY: "dep-or" };
const DESCRIPTION_REPLY = {
  id: "gen-1",
  object: "chat.completion",
  created: 1,
  model: "google/gemini-test",
  choices: [{ index: 0, message: { role: "assistant", content: "A small red fox" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50, cost: 0.0004 },
};

let ws: FakeUpstream;
let fal: FakeUpstream;
let sb: FakeUpstream;
let or: FakeUpstream;
let images: Server;
let imageUrl: string;

beforeEach(async () => {
  [ws, fal, sb, or] = await Promise.all([fakeUpstream(), fakeUpstream(), fakeUpstream(), fakeUpstream(({ path }) => (path.endsWith("/chat/completions") ? { status: 200, body: DESCRIPTION_REPLY } : undefined))]);
  images = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([137, 80, 78, 71]));
  });
  await new Promise<void>((done) => images.listen(0, "127.0.0.1", () => done()));
  imageUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/fox.png`;
});

afterEach(async () => {
  await Promise.all([ws.close(), fal.close(), sb.close(), or.close(), new Promise<void>((done) => images.close(() => done()))]);
});

/**
 * Model `m` on WaveSpeed (1), fal (2) and SandBase (3), and a Kling model whose element step is described first.
 * @param urls - Where each upstream is reached, when not at its fake.
 * @returns The raw configuration.
 */
function config(urls: Partial<Record<"wavespeed" | "fal" | "sandbase", string>> = {}): ProviderConfigInput {
  const media = (upstream: string, weight: number): MediaBinding => ({
    upstream,
    weight,
    model_id: "m",
    prompt_field: "prompt",
    params: { duration: { field: "duration" } },
    ...(upstream === "fal" ? { output_field: "video" } : {}),
    pricing,
  });
  const falUrl = urls.fal ?? fal.url;
  return {
    upstreams: {
      wavespeed: { kind: "wavespeed", base_url: urls.wavespeed ?? ws.url, key_env: "WAVESPEED_API_KEY" },
      fal: { kind: "fal", base_url: falUrl, billing_url: `${falUrl}/v1`, key_env: "FAL_KEY" },
      sandbase: { kind: "sandbase", base_url: urls.sandbase ?? sb.url, key_env: "SANDBASE_API_KEY" },
      openrouter: { kind: "openrouter", base_url: or.url, key_env: "OPENROUTER_API_KEY" },
    },
    llm: {
      routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
      understand_routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
    },
    media: {
      models: {
        m: { upstreams: [media("wavespeed", 1), media("fal", 2), media("sandbase", 3)] },
        "kling-elements": {
          upstreams: [
            {
              upstream: "wavespeed",
              weight: 1,
              model_id: "kwaivgi/kling-video",
              prompt_field: "prompt",
              params: { elements: { field: "elements" } },
              mentions: { elements: "Element {n}" },
              extra_steps: [
                {
                  kind: "element",
                  endpoint: "kwaivgi/kling-elements",
                  at: "before",
                  for_param: "elements",
                  per_item: true,
                  describe: { model: "google/gemini-test", question: "Describe this image in one sentence.", max_output_tokens: 200 },
                },
              ],
              pricing,
            },
          ],
        },
      },
    },
  };
}

/**
 * A provider and its runner over the fakes, reading the deployment's keys through a spy.
 * @param raw - The configuration.
 * @returns Both, and the spy, cleared of whatever building them read.
 */
function started(raw: ProviderConfigInput = config()): { provider: Provider; runner: MediaRunner; deploymentKeys: ReturnType<typeof deploymentKeyOf> } {
  const deploymentKeys = deploymentKeyOf(DEPLOYMENT);
  const provider = createProvider({ config: raw, keyOf: deploymentKeys, llmMaxRetries: 0, cleanText: (t) => t });
  const runner = createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
  deploymentKeys.mockClear();
  return { provider, runner, deploymentKeys };
}

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;
const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });
const planOptions = (keys?: KeySet, llmKeys?: KeySet): Record<string, unknown> => ({
  idempotencyKey: "task-1",
  sourceKeys: { [imageUrl]: "sha-img" },
  clones: [],
  durations: {},
  ...(keys === undefined ? {} : { keys }),
  ...(llmKeys === undefined ? {} : { llmKeys }),
});

/**
 * Narrow an answer to one state, failing the case otherwise.
 * @param answer - The answer.
 * @param state - The state expected.
 * @returns The answer, narrowed.
 */
function expectState<S extends MediaAnswer["state"]>(answer: MediaAnswer, state: S): Extract<MediaAnswer, { state: S }> {
  expect(answer.state).toBe(state);
  return answer as Extract<MediaAnswer, { state: S }>;
}

/**
 * The authorization headers a fake received.
 * @param fake - The fake.
 * @returns Each request's header, in order.
 */
const auths = (fake: FakeUpstream): (string | undefined)[] => fake.seen.map((s) => s.authorization);

/** The WaveSpeed answers of a run that goes through: accept, finish, bill. */
const wavespeedServes = (): void =>
  ws.answer(({ method, path }) => {
    if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
    if (method === "POST" && path === "/kwaivgi/kling-elements") return accepted("p-el");
    if (method === "POST") return accepted("p-gen");
    if (path === "/predictions/p-el/result") return result("p-el", "completed", [{ element_id: "el-1" }]);
    return result("p-gen", "completed", ["https://out.example/v.mp4"]);
  });

describe("an account's key set on a media run", () => {
  it("makes only the upstreams the set has a key for candidates, sends with the account's key and reads no deployment key", async () => {
    const { runner, deploymentKeys } = started();
    fal.answer(({ method }) => (method === "POST" ? { status: 200, body: { request_id: "f1", status_url: `${fal.url}/m/requests/f1/status`, response_url: `${fal.url}/m/requests/f1` } } : undefined));
    const keys = accountKeys({ fal: "acct-fal" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    // WaveSpeed comes first by weight and has the deployment's key, but the account has none for it.
    expect(ws.seen).toHaveLength(0);
    expect(auths(fal)).toEqual(["Key acct-fal"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("fails with account_key_missing when the set has a key for none of the model's upstreams, never using the deployment's", async () => {
    const { runner, deploymentKeys } = started();
    const outcome = await settled(runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(accountKeys({ openrouter: "acct-or" })) as never));
    const failure = keyFailureOf("error" in outcome ? outcome.error : outcome.answer);
    expect(failure).toMatchObject({ kind: "account_key_missing" });
    expect([...ws.seen, ...fal.seen, ...sb.seen]).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("polls and looks up billing with the account's key", async () => {
    const { runner, deploymentKeys } = started();
    ws.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.2 }]);
      if (method === "POST") return accepted("p-1");
      return result("p-1", "completed", ["https://out.example/v.mp4"]);
    });
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const running = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    expectState(await runner.poll(stored(running.ticket), { ...live(), keys }), "done");
    expect(new Set(auths(ws))).toEqual(new Set(["Bearer acct-ws"]));
    expect(deploymentKeys).not.toHaveBeenCalled();
  });
});

describe("the ticket records whose keys each step runs on (critical path)", () => {
  it("refuses a send, poll or recover handed a key set of another owner than the step recorded", async () => {
    const { runner } = started();
    ws.answer(({ method }) => (method === "POST" ? accepted("p-1") : result("p-1", "processing")));
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    // Planned on the account's keys: a send on the deployment's (no keys) is refused before anything is sent.
    await expect(runner.send(stored(planned.ticket), live())).rejects.toThrow();
    expect(ws.seen).toHaveLength(0);
    await expect(runner.recover(stored(planned.ticket), live())).rejects.toThrow();
    const running = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    await expect(runner.poll(stored(running.ticket), live())).rejects.toThrow();
    expect(ws.seen.filter((s) => s.method === "GET")).toHaveLength(0);
  });

  it("refuses a ticket planned on the deployment's keys when a step is handed an account's", async () => {
    const { runner } = started();
    ws.answer(({ method }) => (method === "POST" ? accepted("p-1") : undefined));
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions() as never), "send");
    await expect(runner.send(stored(planned.ticket), { ...live(), keys: accountKeys({ wavespeed: "acct-ws" }) })).rejects.toThrow();
    expect(ws.seen).toHaveLength(0);
  });

  it("records the describe step's owner apart from the media step's, and refuses a describe handed other LLM keys", async () => {
    const { runner } = started();
    wavespeedServes();
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const llmKeys = accountKeys({ openrouter: "acct-or" });
    const planned = expectState(await runner.plan("kling-elements", { prompt: "{{ref:elements:1}} walks", params: { elements: [imageUrl] } }, { mode: "default" }, planOptions(keys, llmKeys) as never), "send");
    expect(planned.step.kind).toBe("describe");
    // The media keys match; the describe step was recorded on the account's LLM keys, not the deployment's.
    await expect(runner.send(stored(planned.ticket), { ...live(), keys })).rejects.toThrow();
    expect(or.seen).toHaveLength(0);
    const described = expectState(await runner.send(stored(planned.ticket), { ...live(), keys, llmKeys }), "send");
    expect(described.step.kind).toBe("element");
    expect(auths(or)).toEqual(["Bearer acct-or"]);
  });

  it("refuses a billing lookup of an accepted prediction handed another owner's keys, and asks with the account's key otherwise", async () => {
    const { provider, runner, deploymentKeys } = started();
    ws.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.3 }]);
      return method === "POST" ? accepted("p-1") : undefined;
    });
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const running = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    const pending = runner.abandon(stored(running.ticket)).costs.find((c): c is Extract<Cost, { state: "pending" }> => c.state === "pending");
    expect(pending).toBeDefined();
    const lookup = JSON.parse(JSON.stringify(pending!.lookup)) as Extract<Cost, { state: "pending" }>["lookup"];
    await expect(provider.cost.lookup(lookup, { lastAttempt: false })).rejects.toThrow();
    ws.seen.length = 0;
    const cost = await provider.cost.lookup(lookup, { lastAttempt: false, keys });
    expect(cost).toMatchObject({ state: "known", usd: 0.3, payer: "account" });
    expect(auths(ws)).toEqual(["Bearer acct-ws"]);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("property: no ticket of a run on account keys ever holds a key, through every step it takes", async () => {
    await fc.assert(
      fc.asyncProperty(printableKeyArb, printableKeyArb, async (mediaKey, llmKey) => {
        fc.pre(mediaKey !== llmKey);
        const { runner } = started();
        wavespeedServes();
        const keys = accountKeys({ wavespeed: mediaKey });
        const llmKeys = accountKeys({ openrouter: llmKey });
        const tickets: MediaTicket[] = [];
        let answer: MediaAnswer = await runner.plan("kling-elements", { prompt: "{{ref:elements:1}} walks", params: { elements: [imageUrl] } }, { mode: "default" }, planOptions(keys, llmKeys) as never);
        for (let i = 0; i < 10 && (answer.state === "send" || answer.state === "running"); i++) {
          tickets.push(answer.ticket);
          const bounds = { ...live(), keys, llmKeys } as never;
          answer = answer.state === "send" ? await runner.send(stored(answer.ticket), bounds) : await runner.poll(stored(answer.ticket), bounds);
        }
        expect(answer.state).toBe("done");
        // The keys were used...
        expect(ws.seen.some((s) => s.authorization === `Bearer ${mediaKey}`)).toBe(true);
        expect(or.seen.some((s) => s.authorization === `Bearer ${llmKey}`)).toBe(true);
        // ...and no ticket, nor the answer that ended the run, carries either.
        for (const t of [...tickets, answer]) {
          const text = JSON.stringify(t);
          expect(text.includes(mediaKey)).toBe(false);
          expect(text.includes(llmKey)).toBe(false);
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe("every cost says who paid it", () => {
  it("splits a Kling element run with media on the account's keys and the description on the deployment's by payer", async () => {
    const { runner, deploymentKeys } = started();
    wavespeedServes();
    const keys = accountKeys({ wavespeed: "acct-ws" });
    let answer: MediaAnswer = await runner.plan("kling-elements", { prompt: "{{ref:elements:1}} walks", params: { elements: [imageUrl] } }, { mode: "default" }, planOptions(keys) as never);
    for (let i = 0; i < 10 && (answer.state === "send" || answer.state === "running"); i++) {
      const bounds = { ...live(), keys } as never;
      answer = answer.state === "send" ? await runner.send(stored(answer.ticket), bounds) : await runner.poll(stored(answer.ticket), bounds);
    }
    const done = expectState(answer, "done");
    for (const cost of done.costs) expect((cost as { payer?: unknown }).payer).toMatch(/^(deployment|account)$/);
    const paidBy = (payer: string): Cost[] => done.costs.filter((c) => (c as { payer?: unknown }).payer === payer);
    // The description is the deployment's OpenRouter call; the element and the generation are the account's WaveSpeed bills.
    expect(paidBy("deployment")).toEqual([{ state: "known", usd: 0.0004, tokens: { input: 10, cachedInput: 0, output: 40, reasoning: 0 }, source: "reported", payer: "deployment" }]);
    expect(paidBy("account").length).toBeGreaterThan(0);
    for (const cost of paidBy("account")) expect(cost).toMatchObject({ state: "known", usd: 0.1, source: "billing" });
    expect(new Set(auths(ws))).toEqual(new Set(["Bearer acct-ws"]));
    expect(auths(or)).toEqual(["Bearer dep-or"]);
    // Only the deployment's OpenRouter key was read.
    expect(deploymentKeys.mock.calls.map(([env]) => env).every((env) => env === "OPENROUTER_API_KEY")).toBe(true);
  });
});

describe("an account-paid description names its upstream", () => {
  it("marks the description's cost on the account's LLM keys with the upstream that billed it, so the caller records it under that key", async () => {
    const { runner } = started();
    wavespeedServes();
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const llmKeys = accountKeys({ openrouter: "acct-or" });
    let answer: MediaAnswer = await runner.plan("kling-elements", { prompt: "{{ref:elements:1}} walks", params: { elements: [imageUrl] } }, { mode: "default" }, planOptions(keys, llmKeys) as never);
    for (let i = 0; i < 10 && (answer.state === "send" || answer.state === "running"); i++) {
      const bounds = { ...live(), keys, llmKeys } as never;
      answer = answer.state === "send" ? await runner.send(stored(answer.ticket), bounds) : await runner.poll(stored(answer.ticket), bounds);
    }
    const done = expectState(answer, "done");
    const described = done.costs.filter((c) => (c as { upstream?: unknown }).upstream === "openrouter");
    expect(described).toEqual([expect.objectContaining({ state: "known", usd: 0.0004, payer: "account", upstream: "openrouter" })]);
    for (const cost of done.costs.filter((c) => !described.includes(c))) expect((cost as { upstream?: unknown }).upstream).toBeUndefined();
  });
});

describe("a failure of an account's key (critical path)", () => {
  type Upstream = "wavespeed" | "fal" | "sandbase";
  const fakeOf = (u: Upstream): FakeUpstream => ({ wavespeed: ws, fal, sandbase: sb })[u];
  const keyFor: Record<Upstream, string> = { wavespeed: "acct-ws", fal: "acct-fal", sandbase: "acct-sb" };
  const authFor: Record<Upstream, string> = { wavespeed: "Bearer acct-ws", fal: "Key acct-fal", sandbase: "Bearer acct-sb" };

  const lasting: { name: string; upstream: Upstream; reply: Reply; reason: string }[] = [
    { name: "fal's account lock", upstream: "fal", reply: { status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } }, reason: "no_balance" },
    { name: "SandBase's plan refusal", upstream: "sandbase", reply: { status: 403, body: { error: "This model is not available to free users." } }, reason: "no_balance" },
    { name: "SandBase's 402", upstream: "sandbase", reply: { status: 402, body: { error: "insufficient balance" } }, reason: "no_balance" },
    { name: "WaveSpeed's 401", upstream: "wavespeed", reply: { status: 401, body: { code: 401, message: "Unauthorized" } }, reason: "invalid" },
    { name: "fal's 401", upstream: "fal", reply: { status: 401, body: { detail: "No user found for Key ID and Secret" } }, reason: "invalid" },
    { name: "SandBase's 401", upstream: "sandbase", reply: { status: 401, body: { error: "invalid api key" } }, reason: "invalid" },
    { name: "WaveSpeed's missing model", upstream: "wavespeed", reply: { status: 400, body: { code: 400, message: "Model not found." } }, reason: "model_not_found" },
    { name: "fal's missing application", upstream: "fal", reply: { status: 404, body: { detail: 'Application "m" not found' } }, reason: "model_not_found" },
    { name: "SandBase's missing model", upstream: "sandbase", reply: { status: 404, body: { error: "model not found: m" } }, reason: "model_not_found" },
  ];

  it.each(lasting)("fails $name as account_key_failed/$reason on that upstream, trying no other upstream and no deployment key", async ({ upstream, reply, reason }) => {
    const { runner, deploymentKeys } = started();
    fakeOf(upstream).answer(({ method }) => (method === "POST" ? reply : undefined));
    const keys = accountKeys({ [upstream]: keyFor[upstream] });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const answer = await runner.send(stored(planned.ticket), { ...live(), keys });
    expect(keyFailureOf(answer)).toMatchObject({ kind: "account_key_failed", reason, upstream });
    expect(auths(fakeOf(upstream))).toEqual([authFor[upstream]]);
    for (const other of (["wavespeed", "fal", "sandbase"] as const).filter((u) => u !== upstream)) expect(fakeOf(other).seen).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("fails a run whose poll the upstream refuses with 401 (the key revoked while it ran) as account_key_failed/invalid", async () => {
    const { runner, deploymentKeys } = started();
    ws.answer(({ method }) => (method === "POST" ? accepted("p-1") : { status: 401, body: { code: 401, message: "Unauthorized" } }));
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const running = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    const answer = await runner.poll(stored(running.ticket), { ...live(), keys });
    expect(keyFailureOf(answer)).toMatchObject({ kind: "account_key_failed", reason: "invalid", upstream: "wavespeed" });
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("asks again after a 429 on a poll of the account's key", async () => {
    const { runner } = started();
    ws.answer(({ method }) => (method === "POST" ? accepted("p-1") : { status: 429, body: { code: 429, message: "Too many requests" } }));
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const running = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "running");
    expectState(await runner.poll(stored(running.ticket), { ...live(), keys }), "running");
  });

  it("keeps another 403 (a content refusal) a refused request, not a key failure", async () => {
    const { runner } = started();
    fal.answer(({ method }) => (method === "POST" ? { status: 403, body: { detail: "Content policy violation" } } : undefined));
    const keys = accountKeys({ fal: "acct-fal" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const failed = expectState(await runner.send(stored(planned.ticket), { ...live(), keys }), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect(keyFailureOf(failed)).toBeUndefined();
    expect(auths(fal)).toEqual(["Key acct-fal"]);
  });

  const passing: { name: string; reply: Reply; kind: string; reason?: string }[] = [
    { name: "429", reply: { status: 429, body: { detail: "Too many requests" } }, kind: "account_key_failed", reason: "rate_limited" },
    { name: "503", reply: { status: 503, body: {} }, kind: "upstream_unavailable" },
  ];

  it.each(passing)("retries a $name on the same upstream and key, and on the caller's last try fails it as $kind", async ({ reply, kind, reason }) => {
    const { runner, deploymentKeys } = started();
    fal.answer(({ method }) => (method === "POST" ? reply : undefined));
    const keys = accountKeys({ fal: "acct-fal", wavespeed: "acct-ws" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "upstream", upstream: "fal" }, planOptions(keys) as never), "send");
    await expect(runner.send(stored(planned.ticket), { ...live(), keys })).rejects.toBeInstanceOf(SendNotAccepted);
    const last = await runner.send(stored(planned.ticket), { ...live(), keys, final: true });
    expect(keyFailureOf(last)).toMatchObject({ kind, ...(reason === undefined ? {} : { reason }), upstream: "fal" });
    // Both sends reached fal (its transport may retry a 429 itself), every one on the account's key.
    expect(auths(fal).length).toBeGreaterThanOrEqual(2);
    expect(new Set(auths(fal))).toEqual(new Set(["Key acct-fal"]));
    expect([...ws.seen, ...sb.seen]).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("retries a 503 in the description step on the account's LLM key, and on the caller's last try fails it as upstream_unavailable", async () => {
    const { runner } = started();
    wavespeedServes();
    or.answer(() => ({ status: 503, body: { error: { message: "busy" } } }));
    const keys = accountKeys({ wavespeed: "acct-ws" });
    const llmKeys = accountKeys({ openrouter: "acct-or" });
    const planned = expectState(await runner.plan("kling-elements", { prompt: "{{ref:elements:1}} walks", params: { elements: [imageUrl] } }, { mode: "default" }, planOptions(keys, llmKeys) as never), "send");
    await expect(runner.send(stored(planned.ticket), { ...live(), keys, llmKeys })).rejects.toBeInstanceOf(SendNotAccepted);
    const last = await runner.send(stored(planned.ticket), { ...live(), keys, llmKeys, final: true });
    expect(keyFailureOf(last)).toMatchObject({ kind: "upstream_unavailable", upstream: "openrouter" });
    expect(new Set(auths(or))).toEqual(new Set(["Bearer acct-or"]));
  });

  it("fails an upstream it cannot connect to as upstream_unavailable on the caller's last try, naming it", async () => {
    const closed = await fakeUpstream();
    const url = closed.url;
    await closed.close();
    const { runner, deploymentKeys } = started(config({ sandbase: url }));
    const keys = accountKeys({ sandbase: "acct-sb" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const outcome = await settled(runner.send(stored(planned.ticket), { ...live(), keys, final: true }));
    expect(keyFailureOf("error" in outcome ? outcome.error : outcome.answer)).toMatchObject({ kind: "upstream_unavailable", upstream: "sandbase" });
    expect([...ws.seen, ...fal.seen]).toHaveLength(0);
    expect(deploymentKeys).not.toHaveBeenCalled();
  });

  it("does not move from one of the account's upstreams to another of them", async () => {
    const { runner } = started();
    ws.answer(({ method }) => (method === "POST" ? { status: 401, body: { code: 401, message: "Unauthorized" } } : undefined));
    fal.answer(({ method }) => (method === "POST" ? { status: 200, body: { request_id: "f1", status_url: `${fal.url}/s`, response_url: `${fal.url}/r` } } : undefined));
    const keys = accountKeys({ wavespeed: "acct-ws", fal: "acct-fal" });
    const planned = expectState(await runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(keys) as never), "send");
    const answer = await runner.send(stored(planned.ticket), { ...live(), keys });
    expect(keyFailureOf(answer)).toMatchObject({ kind: "account_key_failed", reason: "invalid", upstream: "wavespeed" });
    expect(fal.seen).toHaveLength(0);
  });
});

describe("a malformed account key", () => {
  it("property: is refused at the run's entry with an error that never holds it, and nothing is sent", async () => {
    await fc.assert(
      fc.asyncProperty(malformedKeyArb, async (key) => {
        const { runner, deploymentKeys } = started();
        ws.answer(({ method }) => (method === "POST" ? accepted("p-1") : undefined));
        const outcome = await settled(runner.plan("m", { prompt: "a fox", params: {} }, { mode: "default" }, planOptions(accountKeys({ wavespeed: key })) as never));
        const refusal = "error" in outcome ? outcome.error : outcome.answer.state === "failed" ? outcome.answer.reason : undefined;
        expect(refusal).toBeDefined();
        expect(textOf(refusal).includes(key)).toBe(false);
        expect(ws.seen).toHaveLength(0);
        expect(deploymentKeys).not.toHaveBeenCalled();
      }),
      { numRuns: 40 },
    );
  });
});
