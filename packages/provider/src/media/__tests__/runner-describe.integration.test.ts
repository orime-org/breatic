// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfigInput } from "../../config/schema.js";
import { MediaRefused } from "../../http/fetch-media.js";
import { createProvider } from "../../provider.js";
import { createMediaRunner, type MediaAnswer, type MediaRunner, type MediaTicket } from "../runner.js";
import { accepted, billing, fakeUpstream, result, submits, type FakeUpstream } from "./fake-upstream.js";

// The loopback image server stands in for a public host; 10.0.0.5 is private.
vi.mock("../../http/private-address.js", () => ({
  reachable: (url: string) => Promise.resolve(!url.includes("//10.0.0.5")),
}));

const pricing = { kind: "formula", base_price: 0, formula: "", discount_rate: 100 };
const LONG_DESCRIPTION = `A small red fox ${"sitting very still ".repeat(10)}`;

let wavespeed: FakeUpstream;
let openrouter: FakeUpstream;
let images: Server;
let imageUrl: string;

beforeEach(async () => {
  wavespeed = await fakeUpstream();
  openrouter = await fakeUpstream(({ path }) =>
    path.endsWith("/chat/completions")
      ? {
          status: 200,
          body: {
            id: "gen-1",
            object: "chat.completion",
            created: 1,
            model: "google/gemini-test",
            choices: [{ index: 0, message: { role: "assistant", content: LONG_DESCRIPTION }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50, cost: 0.0004 },
          },
        }
      : undefined,
  );
  images = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([137, 80, 78, 71]));
  });
  await new Promise<void>((done) => images.listen(0, "127.0.0.1", () => done()));
  imageUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/fox.png`;
});

afterEach(async () => {
  await Promise.all([wavespeed.close(), openrouter.close(), new Promise<void>((done) => images.close(() => done()))]);
});

/**
 * A Kling model with an element step whose reference images are described first.
 * @returns The raw configuration.
 */
function config(): ProviderConfigInput {
  return {
    upstreams: {
      wavespeed: { kind: "wavespeed", base_url: wavespeed.url, key_env: "WAVESPEED_API_KEY" },
      openrouter: { kind: "openrouter", base_url: openrouter.url, key_env: "OPENROUTER_API_KEY" },
    },
    llm: {
      routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
      understand_routes: [{ prefix: "", upstreams: [{ upstream: "openrouter", weight: 0 }] }],
    },
    media: {
      models: {
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
 * A runner over the fakes.
 * @returns The runner.
 */
function runner(): MediaRunner {
  const keys: Record<string, string> = { WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" };
  const provider = createProvider({ config: config(), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
  return createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 } });
}

const stored = (ticket: MediaTicket): MediaTicket => JSON.parse(JSON.stringify(ticket)) as MediaTicket;

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

const live = (): { deadlineAt: number } => ({ deadlineAt: Date.now() + 60_000 });

describe("the element step's description (design 3.4, Y4, Z2)", () => {
  it("is a public describe step; its send reads the image and asks the understand model, and nothing goes to the media upstream", async () => {
    const r = runner();
    const planned = expectState(
      r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: { [imageUrl]: "sha-img" },
        clones: [],
      }),
      "send",
    );
    expect(planned.step.kind).toBe("describe");
    const described = expectState(await r.send(stored(planned.ticket), live()), "send");
    expect(described.step.kind).toBe("element");
    expect(openrouter.seen.filter((s) => s.path.endsWith("/chat/completions"))).toHaveLength(1);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("feeds the description, cut to 100 characters, to the element submit; the generate submit names elements and rewrites mentions", async () => {
    const r = runner();
    wavespeed.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([{ type: "deduct", price: 0.1 }]);
      if (method === "POST" && path === "/kwaivgi/kling-elements") return accepted("p-el");
      if (method === "POST") return accepted("p-gen");
      if (path === "/predictions/p-el/result") return result("p-el", "completed", [{ element_id: "el-1" }]);
      return result("p-gen", "completed", ["https://out.example/v.mp4"]);
    });
    const planned = expectState(
      r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: { [imageUrl]: "sha-img" },
        clones: [],
      }),
      "send",
    );
    const element = expectState(await r.send(stored(planned.ticket), live()), "send");
    const elementRun = expectState(await r.send(stored(element.ticket), live()), "running");
    expect(submits(wavespeed.seen)[0]?.body).toEqual({
      name: "Element 1",
      description: LONG_DESCRIPTION.slice(0, 100),
      image: imageUrl,
      element_refer_list: [imageUrl],
    });

    const generate = expectState(await r.poll(stored(elementRun.ticket), live()), "send");
    expect(generate.step.kind).toBe("generate");
    expect(generate.clones).toEqual([{ upstream: "wavespeed", kind: "element", sourceKey: "sha-img:Element 1", upstreamId: "el-1" }]);
    const generating = expectState(await r.send(stored(generate.ticket), live()), "running");
    expect(submits(wavespeed.seen)[1]?.body).toEqual({ prompt: "Element 1 walks", elements: [{ element_id: "el-1" }] });

    const done = expectState(await r.poll(stored(generating.ticket), live()), "done");
    expect(done.costs).toContainEqual({ state: "known", usd: 0.0004, source: "reported" });
  });

  it("answers failed with MediaRefused for an image at a private address, asking no model", async () => {
    const r = runner();
    const planned = expectState(
      r.plan("kling-elements", { prompt: "go", params: { elements: ["http://10.0.0.5/x.png"] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: {},
        clones: [],
      }),
      "send",
    );
    const failed = expectState(await r.send(stored(planned.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(MediaRefused);
    expect(openrouter.seen).toHaveLength(0);
    expect(wavespeed.seen).toHaveLength(0);
  });
});
