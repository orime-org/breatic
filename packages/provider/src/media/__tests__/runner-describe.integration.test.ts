// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfigInput } from "../../config/schema.js";
import { MediaRefused } from "../../http/fetch-media.js";
import { createProvider } from "../../provider.js";
import { costsOf, DeadlinePassed, NoUpstreamAvailable, SendNotAccepted, UpstreamRequestRejected, UpstreamTaskFailed } from "../../errors.js";
import { createMediaRunner, type MediaAnswer, type MediaClone, type MediaRunner, type MediaTicket } from "../runner.js";
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
/** The Content-Type the image server answers with; undefined sends none. */
let imageType: string | undefined;

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
  imageType = "image/png";
  images = createServer((_req, res) => {
    res.writeHead(200, imageType === undefined ? {} : { "content-type": imageType });
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
 * The same model bound a second time, to another WaveSpeed-kind upstream at weight 2.
 * @param second - The second upstream's fake.
 * @returns The raw configuration.
 */
function twoUpstreams(second: FakeUpstream): ProviderConfigInput {
  const raw = config();
  const [binding] = raw.media.models["kling-elements"]!.upstreams;
  raw.upstreams.wavespeed_b = { kind: "wavespeed", base_url: second.url, key_env: "WAVESPEED_B_API_KEY" };
  raw.media.models["kling-elements"]!.upstreams.push({ ...binding!, upstream: "wavespeed_b", weight: 2 });
  return raw;
}

/**
 * A runner over the fakes.
 * @returns The runner.
 */
function runner(raw: ProviderConfigInput = config()): MediaRunner {
  const keys: Record<string, string> = { WAVESPEED_API_KEY: "ws-key", WAVESPEED_B_API_KEY: "ws-b-key", OPENROUTER_API_KEY: "or-key" };
  const provider = createProvider({ config: raw, keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
  return createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
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
      await r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
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
      await r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
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
    expect(done.costs).toContainEqual({ state: "known", usd: 0.0004, tokens: { input: 10, cachedInput: 0, output: 40, reasoning: 0 }, source: "reported" });
  });

  it("answers failed with MediaRefused for an image at a private address, asking no model", async () => {
    const r = runner();
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: ["http://10.0.0.5/x.png"] } }, { mode: "default" }, {
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

describe("the element image's type (design 3.1, DD 28)", () => {
  /**
   * Plan and send the describe step of one element image.
   * @returns The answer of the send.
   */
  const describeImage = async (): Promise<MediaAnswer> => {
    const r = runner();
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [imageUrl] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: { [imageUrl]: "sha-img" },
        clones: [],
      }),
      "send",
    );
    return r.send(stored(planned.ticket), live());
  };

  /**
   * The data URI type of the image the understand request carried.
   * @returns The type.
   */
  const sentType = (): string | undefined => {
    const body = openrouter.seen.find((s) => s.path.endsWith("/chat/completions"))?.body as { messages: { content: { type: string; image_url?: { url: string } }[] }[] };
    const url = body.messages[0]!.content.find((p) => p.type === "image_url")?.image_url?.url ?? "";
    return /^data:([^;,]*)/.exec(url)?.[1];
  };

  it.each([
    ["application/octet-stream", "application/octet-stream"],
    ["no type", undefined],
    ["a type with parameters in capitals", "IMAGE/PNG; charset=binary"],
  ])("sends an image served as %s under the type its extension or declaration settles to", async (_name, served) => {
    imageType = served;
    expectState(await describeImage(), "send");
    expect(sentType()).toBe("image/png");
  });

  it("answers failed with MediaRefused for an address that serves no image type, asking no model", async () => {
    imageType = "text/html";
    const failed = expectState(await describeImage(), "failed");
    expect(failed.reason).toBeInstanceOf(MediaRefused);
    expect(openrouter.seen).toHaveLength(0);
  });
});

describe("cached elements", () => {
  const second = "https://cdn.example/cat.png";

  it("reuses this upstream's cached element without describing or creating it again", async () => {
    const r = runner();
    wavespeed.answer(({ method }) => (method === "POST" ? accepted("p-gen") : result("p-gen", "processing")));
    const cached: MediaClone[] = [{ upstream: "wavespeed", kind: "element", sourceKey: "sha-img:Element 1", upstreamId: "el-cached" }];
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: { [imageUrl]: "sha-img" },
        clones: cached,
      }),
      "send",
    );
    expect(planned.step.kind).toBe("generate");
    await r.send(stored(planned.ticket), live());
    expect(submits(wavespeed.seen).map((s) => s.body)).toEqual([{ prompt: "Element 1 walks", elements: [{ element_id: "el-cached" }] }]);
    expect(openrouter.seen).toHaveLength(0);
  });

  it("retires only the cached element the upstream names as gone", async () => {
    const r = runner();
    wavespeed.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      return method === "POST" ? accepted("p-gen") : result("p-gen", "failed", [], "Element id not found: el-2");
    });
    const cached: MediaClone[] = [
      { upstream: "wavespeed", kind: "element", sourceKey: "sha-img:Element 1", upstreamId: "el-1" },
      { upstream: "wavespeed", kind: "element", sourceKey: "sha-cat:Element 2", upstreamId: "el-2" },
    ];
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [imageUrl, second] } }, { mode: "default" }, {
        idempotencyKey: "task-1",
        sourceKeys: { [imageUrl]: "sha-img", [second]: "sha-cat" },
        clones: cached,
      }),
      "send",
    );
    const running = expectState(await r.send(stored(planned.ticket), live()), "running");
    const failed = expectState(await r.poll(stored(running.ticket), live()), "failed");
    expect(failed.reason).toBeInstanceOf(UpstreamTaskFailed);
    expect(failed.retiredClones).toEqual([cached[1]]);
  });

  it("describes and creates one element per reference image, in the images' order, before the video", async () => {
    const r = runner();
    let element = 0;
    wavespeed.answer(({ method, path }) => {
      if (path === "/billings/search") return billing([]);
      if (method === "POST" && path === "/kwaivgi/kling-elements") return accepted(`p-el-${++element}`);
      if (method === "POST") return accepted("p-gen");
      const id = path.split("/")[2] ?? "";
      return id.startsWith("p-el-") ? result(id, "completed", [{ element_id: `el-${id.slice(5)}` }]) : result(id, "processing");
    });
    let answer: MediaAnswer = await r.plan("kling-elements", { prompt: "go", params: { elements: [imageUrl, imageUrl] } }, { mode: "default" }, {
      idempotencyKey: "task-1",
      sourceKeys: {},
      clones: [],
    });
    const kinds: string[] = [];
    while (answer.state === "send" || (answer.state === "running" && kinds.at(-1) !== "generate")) {
      if (answer.state === "send") kinds.push(answer.step.kind);
      answer = answer.state === "send" ? await r.send(stored(answer.ticket), live()) : await r.poll(stored(answer.ticket), live());
    }
    expect(kinds).toEqual(["describe", "element", "describe", "element", "generate"]);
    expect(submits(wavespeed.seen).map((s) => (s.body as { name?: string }).name)).toEqual(["Element 1", "Element 2", undefined]);
    expect(submits(wavespeed.seen)[2]?.body).toMatchObject({ elements: [{ element_id: "el-1" }, { element_id: "el-2" }] });
  });
});


describe("a describe step followed by a switch (design 3.4, 5.3)", () => {
  it("keeps the paid description in the moved ticket's costs", async () => {
    const second = await fakeUpstream(({ method }) => (method === "POST" ? accepted("p-el") : result("p-el", "processing")));
    try {
      const r = runner(twoUpstreams(second));
      wavespeed.answer(() => ({ status: 503, body: {} }));
      const planned = expectState(
        await r.plan("kling-elements", { prompt: "<<ref:elements:1>> walks", params: { elements: [imageUrl] } }, { mode: "default" }, {
          idempotencyKey: "task-1",
          sourceKeys: { [imageUrl]: "sha-img" },
          clones: [],
        }),
        "send",
      );
      const element = expectState(await r.send(stored(planned.ticket), live()), "send");
      const moved = expectState(await r.send(stored(element.ticket), live()), "send");
      expect(moved.ticket.upstream).toBe("wavespeed_b");
      expect(moved.ticket.costs).toEqual([{ state: "known", usd: 0.0004, tokens: { input: 10, cachedInput: 0, output: 40, reasoning: 0 }, source: "reported" }]);
    } finally {
      await second.close();
    }
  });
});

describe("a describe step that cannot read its image (design 3.2)", () => {
  /**
   * Plan the model over one image and send its describe step.
   * @param image - The image url.
   * @param bounds - The send's bounds.
   * @returns What send did.
   */
  async function describeOnly(image: string, bounds: { deadlineAt: number }): Promise<unknown> {
    const r = runner();
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [image] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }),
      "send",
    );
    return r.send(stored(planned.ticket), bounds).catch((e: unknown) => e);
  }

  it("throws SendNotAccepted when the image host refuses the connection", async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", () => done()));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((done) => closed.close(() => done()));
    expect(await describeOnly(`http://127.0.0.1:${port}/fox.png`, live())).toBeInstanceOf(SendNotAccepted);
    expect(openrouter.seen).toHaveLength(0);
  });

  it("throws DeadlinePassed when the deadline passes while the image is read", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
    try {
      const { port } = silent.address() as AddressInfo;
      expect(await describeOnly(`http://127.0.0.1:${port}/fox.png`, { deadlineAt: Date.now() + 300 })).toBeInstanceOf(DeadlinePassed);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((done) => silent.close(() => done()));
    }
  });

  /**
   * Describe an image whose host answers every read with one status.
   * @param status - The status.
   * @returns What send did.
   */
  async function hostAnswering(status: number): Promise<unknown> {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const host = createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((done) => host.listen(0, "127.0.0.1", () => done()));
    try {
      return await describeOnly(`http://127.0.0.1:${(host.address() as AddressInfo).port}/fox.png`, live());
    } finally {
      vi.restoreAllMocks();
      await new Promise<void>((done) => host.close(() => done()));
    }
  }

  it.each([408, 429, 500, 503])("throws SendNotAccepted when the image host answers %i, which may pass (DD 33)", async (status) => {
    expect(await hostAnswering(status)).toBeInstanceOf(SendNotAccepted);
    expect(openrouter.seen).toHaveLength(0);
  });

  it.each([403, 404])("answers failed with MediaRefused when the image host answers %i (DD 33)", async (status) => {
    const failed = expectState(await hostAnswering(status) as MediaAnswer, "failed");
    expect(failed.reason).toBeInstanceOf(MediaRefused);
    expect(openrouter.seen).toHaveLength(0);
  });

  it("answers failed with MediaRefused when the image is empty, asking no model (DD 33)", async () => {
    const host = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    });
    await new Promise<void>((done) => host.listen(0, "127.0.0.1", () => done()));
    try {
      const failed = expectState(await describeOnly(`http://127.0.0.1:${(host.address() as AddressInfo).port}/fox.png`, live()) as MediaAnswer, "failed");
      expect((failed.reason as MediaRefused).kind).toBe("empty");
      expect(openrouter.seen).toHaveLength(0);
    } finally {
      await new Promise<void>((done) => host.close(() => done()));
    }
  });
});

describe("a describe step whose understand call reaches no upstream (design 3.2, 5.3, 9)", () => {
  /**
   * Plan the model and send its describe step with the given keys.
   * @param keys - The environment keys.
   * @returns What send did.
   */
  async function describeWith(keys: Record<string, string>): Promise<unknown> {
    const provider = createProvider({ config: config(), keyOf: (name) => keys[name], llmMaxRetries: 0, cleanText: (t) => t });
    const r = createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [imageUrl] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }),
      "send",
    );
    return r.send(stored(planned.ticket), live()).catch((e: unknown) => e);
  }

  it("answers failed naming the missing key when no understand upstream is configured", async () => {
    const answer = expectState((await describeWith({ WAVESPEED_API_KEY: "ws-key" })) as MediaAnswer, "failed");
    expect(answer.reason).toBeInstanceOf(NoUpstreamAvailable);
    expect((answer.reason as NoUpstreamAvailable).reasons).toEqual([{ upstream: "openrouter", kind: "missing_key", envVar: "OPENROUTER_API_KEY" }]);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("throws SendNotAccepted when the understand upstreams fail in a passing way", async () => {
    openrouter.answer(() => ({ status: 503, body: {} }));
    expect(await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" })).toBeInstanceOf(SendNotAccepted);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("throws SendNotAccepted when OpenRouter answers 200 with an error that stands for a 502", async () => {
    openrouter.answer(() => ({ status: 200, body: { error: { message: "Provider returned error", code: 502 } } }));
    expect(await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" })).toBeInstanceOf(SendNotAccepted);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("throws SendNotAccepted whose cause carries the cost OpenRouter billed for the answer it could not use (DD 25)", async () => {
    openrouter.answer(() => ({
      status: 200,
      body: { id: "gen-1", usage: { cost: 0.0007 }, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code: 502, message: "Upstream died" } }] },
    }));
    const error = await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" });
    expect(error).toBeInstanceOf(SendNotAccepted);
    expect(((error as Error).cause as NoUpstreamAvailable).costs).toEqual([expect.objectContaining({ state: "known", usd: 0.0007 })]);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("throws DeadlinePassed from whose cause chain costsOf reads the billed answer the deadline cut short (DD 26)", async () => {
    let n = 0;
    openrouter.answer(() =>
      ++n === 1
        ? { status: 200, body: { id: "gen-1", usage: { cost: 0.0007 }, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code: 502, message: "Upstream died" } }] } }
        : "hang");
    const provider = createProvider({ config: config(), keyOf: (name) => ({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" })[name], llmMaxRetries: 1, cleanText: (t) => t });
    const r = createMediaRunner(provider, { mediaLimits: { maxMediaBytes: 1_000_000 }, pollIntervalMs: 0 });
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [imageUrl] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }),
      "send",
    );
    const error = await r.send(stored(planned.ticket), { deadlineAt: Date.now() + 1_500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlinePassed);
    expect(costsOf(error)).toEqual([expect.objectContaining({ state: "known", usd: 0.0007 })]);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("lets costsOf read the cost on the cause of SendNotAccepted", async () => {
    openrouter.answer(() => ({
      status: 200,
      body: { id: "gen-1", usage: { cost: 0.0007 }, choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code: 502, message: "Upstream died" } }] },
    }));
    const error = await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" });
    expect(error).toBeInstanceOf(SendNotAccepted);
    expect(costsOf(error)).toEqual([expect.objectContaining({ state: "known", usd: 0.0007 })]);
  });

  it("answers failed, submitting nothing, when OpenRouter's choice carries a refusing error and no description", async () => {
    openrouter.answer(() => ({
      status: 200,
      body: { id: "gen-1", choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "error", error: { code: 400, message: "image unreadable" } }] },
    }));
    const answer = expectState((await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" })) as MediaAnswer, "failed");
    expect(answer.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect(wavespeed.seen).toHaveLength(0);
  });

  it("answers failed with UpstreamRequestRejected when the understand upstream refuses the request", async () => {
    openrouter.answer(() => ({ status: 400, body: { error: { message: "image unreadable", code: 400 } } }));
    const answer = expectState((await describeWith({ WAVESPEED_API_KEY: "ws-key", OPENROUTER_API_KEY: "or-key" })) as MediaAnswer, "failed");
    expect(answer.reason).toBeInstanceOf(UpstreamRequestRejected);
  });
});

describe("a describe step and the understand model's answer (design 3.5, 5.4)", () => {
  /**
   * Plan the model over the image and send its describe step.
   * @param image - The image url.
   * @returns What send did.
   */
  async function describeImage(image = imageUrl): Promise<unknown> {
    const r = runner();
    const planned = expectState(
      await r.plan("kling-elements", { prompt: "go", params: { elements: [image] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }),
      "send",
    );
    return r.send(stored(planned.ticket), live()).catch((e: unknown) => e);
  }

  it("answers failed naming the understand upstream, and keeps the cost it billed for the refusal", async () => {
    openrouter.answer(() => ({ status: 200, body: { id: "gen-r", error: { message: "The model declined", code: 200 }, usage: { cost: 0.0005 } } }));
    const answer = expectState((await describeImage()) as MediaAnswer, "failed");
    expect(answer.reason).toBeInstanceOf(UpstreamRequestRejected);
    expect((answer.reason as UpstreamRequestRejected).upstream).toBe("openrouter");
    expect(answer.costs).toContainEqual(expect.objectContaining({ state: "known", usd: 0.0005 }));
  });

  it("throws SendNotAccepted when the image host drops the connection, since nothing paid was sent", async () => {
    const dropping = createServer((req) => req.socket.destroy());
    await new Promise<void>((done) => dropping.listen(0, "127.0.0.1", () => done()));
    try {
      const { port } = dropping.address() as AddressInfo;
      expect(await describeImage(`http://127.0.0.1:${port}/fox.png`)).toBeInstanceOf(SendNotAccepted);
      expect(openrouter.seen).toHaveLength(0);
    } finally {
      await new Promise<void>((done) => dropping.close(() => done()));
    }
  });

  it("throws the caller's stop while the image is read as it is, before the deadline", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
    try {
      const { port } = silent.address() as AddressInfo;
      const r = runner();
      const planned = expectState(
        await r.plan("kling-elements", { prompt: "go", params: { elements: [`http://127.0.0.1:${port}/fox.png`] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }),
        "send",
      );
      const stop = new AbortController();
      setTimeout(() => stop.abort(), 100);
      const error = await r.send(stored(planned.ticket), { deadlineAt: Date.now() + 60_000, signal: stop.signal }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SendNotAccepted);
      expect(error).not.toBeInstanceOf(DeadlinePassed);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((done) => silent.close(() => done()));
    }
  });

  it("throws the lost answer of the understand call as it is, since that call may have been billed", async () => {
    openrouter.answer(() => "reset");
    const error = await describeImage();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SendNotAccepted);
    expect((error as { state?: unknown }).state).toBeUndefined();
  });
});

describe("ticketFromLegacy for an element step not yet sent (design 3.4, X3)", () => {
  it("describes the image first, as a fresh plan does", async () => {
    const legacy = {
      steps: [
        { position: 0, kind: "element" as const, endpoint: "kwaivgi/kling-elements", itemIndex: 0, status: "pending" as const, predictionId: null, output: {}, inlineCostUsd: 0 },
        { position: 1, kind: "generate" as const, endpoint: "kwaivgi/kling-video", itemIndex: null, status: "pending" as const, predictionId: null, output: {}, inlineCostUsd: 0 },
      ],
    };
    const answer = expectState(
      await runner().ticketFromLegacy("kling-elements", { prompt: "go", params: { elements: [imageUrl] } }, { mode: "default" }, { idempotencyKey: "task-1", sourceKeys: {}, clones: [] }, legacy),
      "send",
    );
    expect(answer.step.kind).toBe("describe");
  });
});
