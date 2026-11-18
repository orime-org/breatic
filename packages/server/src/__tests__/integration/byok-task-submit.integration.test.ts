// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every submission that ends in a model call settles, when the server accepts it, which keys it runs on (inner#1953):
 * the keys of whoever pays for the project's Studio, as `resolveKeys` answers. The task row records the key rows by
 * id, `key_id` for the media and `llm_key_id` for a language-model step or a reading (null on our keys), never a key.
 * What an account's key pays for is neither held nor checked against the Studio's credits; what our keys pay for is
 * held exactly as before. A model the deployment has no key for is accepted when the payer's key can run it, and
 * refused as before when neither can. A model pointed at an upstream whose key is gone runs on our keys.
 *
 * Covered here: canvas generation, canvas understanding and transcription, a model mini-tool, a 3D generation and a
 * Timeline web-animation execution, each through the real app, database and Redis with payments on, so a hold, were
 * one written, would be a real `credit_holds` row. The deployment's keys are set per case; no worker runs behind the
 * queue, so nothing reaches an upstream.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { createProvider } from "@breatic/provider";
import {
  accountModelUpstreamsRepo,
  accountProviderKeysRepo,
  getRedis,
  initCore,
  loadLocales,
  sealProviderKey,
  sessionCookieName,
  setSession,
} from "@breatic/core";
import { estimateTaskCredits, initProvider, readProviderConfig } from "@breatic/domain";
import { ceilToCreditCent } from "@breatic/shared";
import { seedDesignatedLot } from "@server/__tests__/integration/studio-credit-fixtures.js";

const SECRET = crypto.randomBytes(32);
const RING = { current: "t1", keys: { t1: SECRET } };

initCore({
  ...process.env,
  PAYMENT_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  PROVIDER_KEY_SECRET_ID: "t1",
  PROVIDER_KEY_SECRETS: JSON.stringify({ t1: SECRET.toString("hex") }),
});
loadLocales();

/** The deployment's own keys, by the variable each upstream reads; a case narrows them. */
const deployed = new Set<string>();

/**
 * Build this process's provider on the shipped configuration with only these deployment keys set.
 * @param envNames - The variables the deployment has a key in.
 */
function deploy(...envNames: string[]): void {
  deployed.clear();
  for (const name of envNames) deployed.add(name);
  initProvider(createProvider({
    config: readProviderConfig(),
    keyOf: (name: string) => (deployed.has(name) ? "deployment-suite-key" : undefined),
    llmMaxRetries: 0,
    cleanText: (text: string) => text,
  }));
}

/** A media model bound on WaveSpeed, fal and SandBase in `config/provider/media/image.yaml`. */
const IMAGE = "gpt-image-2.5-sunburst-text-to-image";
/** A media model with a language-model step inside its run (its prompt is rewritten). */
const REWRITTEN = "nano-banana-2";
/** The model `image.remove-bg` runs, bound on WaveSpeed and fal. */
const REMOVE_BG = "bria-remove-background";
/** A video model whose run first describes each element image on a language model, bound on WaveSpeed and fal (which takes no elements). */
const KLING_O3 = "kling-video-o3-4k-image-to-video";
/** A Kling O3 run with one element, so its description step runs. */
const KLING_PARAMS = {
  prompt: "Element 1 walks along a beach at sunset",
  image: "https://assets.example.test/start.png",
  elements: ["https://assets.example.test/element.png"],
  duration: 5,
};

/** A 3D model bound on WaveSpeed, fal and SandBase; only WaveSpeed takes its default `delight`. */
const T23D = "tripo-h3.1-t23d";

const FAL_KEY = "fal-account-key-never-stored";
/** fal takes neither Tripo's default `delight` nor Kling O3's `elements`, so the runs that need them go to WaveSpeed. */
const WAVESPEED_KEY = "ws-account-key-never-stored";
const OPENROUTER_KEY = "sk-or-v1-account-key-never-stored";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false, connection: { application_name: "byok-task-submit-driver" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  // A deployment with WaveSpeed and OpenRouter keys: every model here is servable on our keys.
  deploy("WAVESPEED_API_KEY", "OPENROUTER_API_KEY");
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

interface Fixture {
  userId: string;
  cookie: string;
  studioId: string;
  projectId: string;
  spaceId: string;
}

/**
 * A signed-in admin of a team Studio with a project in it, and the credits designated to the Studio.
 * @param credits - What the Studio can spend; 0 seeds none.
 * @param spaceType - The project's first Space type.
 * @returns Ids, the cookie and a Space id.
 */
async function seed(credits: number, spaceType: "canvas" | "timeline" = "canvas"): Promise<Fixture> {
  const tag = crypto.randomBytes(8).toString("hex");
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`byok-submit-${tag}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${`byok-s-${tag}`}, 'team', 'BYOK') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
    VALUES (${studio!.id}, ${userId}, ${`byok-p-${tag}`}, ${`byok-p-${tag}`}, ${spaceType}) RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${userId}, 'owner', null)`;
  if (credits > 0) await seedDesignatedLot(sql, { userId, studioId: studio!.id, projectId: project!.id }, credits);
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, cookie: `${sessionCookieName()}=${token}`, studioId: studio!.id, projectId: project!.id, spaceId: crypto.randomUUID() };
}

/**
 * Save an account's key the way the settings route will: sealed with this deployment's ring.
 * @param userId - The account.
 * @param upstream - The upstream.
 * @param key - The key itself.
 * @returns The key row's id.
 */
async function saveKey(userId: string, upstream: string, key: string): Promise<string> {
  const saved = await accountProviderKeysRepo.saveKey({ userId, upstream, ciphertext: sealProviderKey(key, RING), displayHint: "hint" });
  return saved.id;
}

/**
 * Give an account a key on an upstream and point a model at that upstream.
 * @param userId - The account.
 * @param model - The model.
 * @param upstream - The upstream.
 * @param key - The key.
 * @returns The key row's id.
 */
async function pointAt(userId: string, model: string, upstream: string, key: string): Promise<string> {
  const keyId = await saveKey(userId, upstream, key);
  await accountModelUpstreamsRepo.setModelUpstream(userId, model, upstream);
  return keyId;
}

/**
 * POST a JSON body with a fresh Idempotency-Key.
 * @param fx - Who.
 * @param path - Path under /api/v1.
 * @param body - The body.
 * @returns The response.
 */
async function post(fx: Fixture, path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Cookie: fx.cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

/** The ways in that create a `tasks` row, each answering the task's id. */
const SUBMIT = {
  generate: (fx: Fixture, model: string): Promise<Response> =>
    post(fx, "/canvas/tasks", { project_id: fx.projectId, space_id: fx.spaceId, task_type: "image", model, mode: "append", params: { prompt: "a red fox" } }),
  understand: (fx: Fixture): Promise<Response> =>
    post(fx, "/canvas/understand", {
      project_id: fx.projectId, space_id: fx.spaceId, source_type: "image", source_url: "https://assets.example.test/fox.png", node_ids: [crypto.randomUUID()], prompt: "Describe it",
    }),
  transcribe: (fx: Fixture): Promise<Response> =>
    post(fx, "/canvas/transcribe", {
      project_id: fx.projectId, space_id: fx.spaceId, source_type: "audio", source_url: "https://assets.example.test/talk.mp3", node_ids: [crypto.randomUUID()], keep_fillers: false,
    }),
  miniTool: (fx: Fixture): Promise<Response> =>
    post(fx, "/mini-tools", {
      project_id: fx.projectId, space_id: fx.spaceId, tool: "image.remove-bg", source: { url: "https://assets.example.test/fox.png" }, slots: {}, params: {}, node_ids: [crypto.randomUUID()],
    }),
  threeD: (fx: Fixture): Promise<Response> =>
    post(fx, `/projects/${fx.projectId}/three-d/${fx.spaceId}/generations`, {
      mode: "t23d", model: T23D, prompt: "a red barn lamp", params: {}, origin: "space",
    }),
};

/**
 * The task id an accepted submission answered with, after checking it was accepted.
 * @param res - The response.
 * @returns The task id and the status it answered.
 */
async function acceptedTask(res: Response): Promise<{ taskId: string; status: string | undefined }> {
  expect(res.status, await res.clone().text()).toBe(201);
  const data = ((await res.json()) as { data: { task_id: string; status?: string } }).data;
  return { taskId: data.task_id, status: data.status };
}

/**
 * The key rows a task was accepted on.
 * @param taskId - The task.
 * @returns Its `key_id` and `llm_key_id`.
 */
async function keyColumns(taskId: string): Promise<{ key_id: string | null; llm_key_id: string | null }> {
  const [row] = await sql<{ key_id: string | null; llm_key_id: string | null }[]>`SELECT key_id, llm_key_id FROM tasks WHERE id = ${taskId}`;
  return row!;
}

/**
 * The whole task row, as text, to look for a key in it.
 * @param taskId - The task.
 * @returns The row as JSON.
 */
async function taskRowText(taskId: string): Promise<string> {
  const rows = await sql`SELECT * FROM tasks WHERE id = ${taskId}`;
  return JSON.stringify(rows);
}

/**
 * The holds taken under a task's id.
 * @param taskId - The task.
 * @returns Their amounts.
 */
async function holdsFor(taskId: string): Promise<number[]> {
  const rows = await sql<{ amount: string }[]>`SELECT amount::text AS amount FROM credit_holds WHERE reference_id = ${taskId}`;
  return rows.map((row) => Number(row.amount));
}

describe("a canvas generation", () => {
  it("runs a model the payer pointed at fal on the payer's fal key row, holding nothing, with no credits in the Studio", async () => {
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, IMAGE, "fal", FAL_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, IMAGE));

    expect(await keyColumns(taskId)).toEqual({ key_id: keyId, llm_key_id: null });
    expect(await holdsFor(taskId)).toEqual([]);
    const [task] = await sql<{ params: Record<string, unknown> }[]>`SELECT params FROM tasks WHERE id = ${taskId}`;
    expect(task!.params.route).toEqual({ mode: "upstream", upstream: "fal" });
    expect(await taskRowText(taskId)).not.toContain(FAL_KEY);
  });

  it("records the payer's OpenRouter key row for the language-model step of a model whose prompt is rewritten, and holds the media on our keys", async () => {
    const fx = await seed(100_000);
    const llmKeyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, REWRITTEN));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: llmKeyId });
    expect((await holdsFor(taskId)).length).toBe(1);
    expect(await taskRowText(taskId)).not.toContain(OPENROUTER_KEY);
  });

  it("admits a model whose prompt is rewritten on the payer's media key with no credits in the Studio, since the rewrite on our keys is never charged", async () => {
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, REWRITTEN, "wavespeed", WAVESPEED_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, REWRITTEN));

    expect(await keyColumns(taskId)).toEqual({ key_id: keyId, llm_key_id: null });
    expect(await holdsFor(taskId)).toEqual([]);
  });

  it("holds the estimate on our keys, as before", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, IMAGE));

    const held = await holdsFor(taskId);
    expect(held).toHaveLength(1);
    expect(held[0]).toBeGreaterThan(0);
  });

  it("records no key row on our keys", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, IMAGE));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
  });

  it("refuses a run on our keys that the Studio's credits cannot cover, as before", async () => {
    const fx = await seed(0);

    expect((await SUBMIT.generate(fx, IMAGE)).status).toBe(402);
    expect(await sql`SELECT id FROM tasks WHERE project_id = ${fx.projectId}`).toHaveLength(0);
  });

  it("runs on our keys, holding the estimate, once the upstream the payer pointed the model at has lost its key", async () => {
    const fx = await seed(100_000);
    await pointAt(fx.userId, IMAGE, "fal", FAL_KEY);
    // Only the key row is retired, so the choice still names fal: the key's own state decides.
    await sql`UPDATE account_provider_keys SET deleted_at = now(), ciphertext = NULL WHERE user_id = ${fx.userId} AND upstream = 'fal'`;

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, IMAGE));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
    expect((await holdsFor(taskId)).length).toBe(1);
    const [task] = await sql<{ params: Record<string, unknown> }[]>`SELECT params FROM tasks WHERE id = ${taskId}`;
    expect(task!.params.route).toBeUndefined();
  });
});

describe("Kling O3 with elements, whose description step runs on a language model", () => {
  /**
   * Submit the run.
   * @param fx - Who.
   * @returns The response.
   */
  const submitKling = (fx: Fixture): Promise<Response> =>
    post(fx, "/canvas/tasks", { project_id: fx.projectId, space_id: fx.spaceId, task_type: "video", model: KLING_O3, mode: "append", params: KLING_PARAMS });

  /**
   * What the media alone is held for: the run's estimate, which leaves the description step out.
   * @returns The credits.
   */
  const mediaEstimate = async (): Promise<number> =>
    ceilToCreditCent(await estimateTaskCredits(KLING_O3, { params: KLING_PARAMS, prompt: KLING_PARAMS.prompt }));

  it("records the payer's OpenRouter key row for the description and holds only the media's estimate on our keys", async () => {
    const fx = await seed(100_000);
    const llmKeyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

    const { taskId } = await acceptedTask(await submitKling(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: llmKeyId });
    expect(await holdsFor(taskId)).toEqual([await mediaEstimate()]);
    expect(await taskRowText(taskId)).not.toContain(OPENROUTER_KEY);
  });

  it("is admitted with no credits in the Studio, holding nothing, when the media and the description both run on the payer's keys", async () => {
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, KLING_O3, "wavespeed", WAVESPEED_KEY);
    const llmKeyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

    const { taskId } = await acceptedTask(await submitKling(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: keyId, llm_key_id: llmKeyId });
    expect(await holdsFor(taskId)).toEqual([]);
  });

  it("is refused with no credits in the Studio when the media runs on the payer's key and the charged description on ours", async () => {
    const fx = await seed(0);
    await pointAt(fx.userId, KLING_O3, "wavespeed", WAVESPEED_KEY);

    expect((await submitKling(fx)).status).toBe(402);
  });

  it("on our keys holds only the media's estimate, nothing for the description, as before", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await submitKling(fx));

    expect(await holdsFor(taskId)).toEqual([await mediaEstimate()]);
  });

  it("on our keys is refused with no credits in the Studio, as before", async () => {
    const fx = await seed(0);

    expect((await submitKling(fx)).status).toBe(402);
  });

  it("on our keys records no key row", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await submitKling(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
  });
});

describe("availability at submit", () => {
  it("accepts a model the deployment has no key for when the payer's key can run it", async () => {
    deploy();
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, IMAGE, "fal", FAL_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.generate(fx, IMAGE));

    expect((await keyColumns(taskId)).key_id).toBe(keyId);
  });

  it("refuses a model neither the deployment nor the payer can run, as before", async () => {
    deploy();
    const fx = await seed(100_000);

    expect((await SUBMIT.generate(fx, IMAGE)).status).toBe(503);
  });

  it("refuses a model the payer holds a key for but did not point anywhere, when the deployment has none", async () => {
    deploy();
    const fx = await seed(100_000);
    await saveKey(fx.userId, "fal", FAL_KEY);

    expect((await SUBMIT.generate(fx, IMAGE)).status).toBe(503);
  });

  it("accepts a reading the deployment has no understanding key for when the payer has an OpenRouter key", async () => {
    deploy("WAVESPEED_API_KEY");
    const fx = await seed(0);
    const llmKeyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

    const { taskId, status } = await acceptedTask(await SUBMIT.understand(fx));

    expect(status).toBe("pending");
    expect((await keyColumns(taskId)).llm_key_id).toBe(llmKeyId);
  });

  it("refuses a reading when neither the deployment nor the payer has a key for it, as before", async () => {
    deploy("WAVESPEED_API_KEY");
    const fx = await seed(100_000);

    expect((await SUBMIT.understand(fx)).status).toBe(503);
  });
});

describe("a canvas reading", () => {
  for (const lane of ["understand", "transcribe"] as const) {
    it(`${lane}: runs on the payer's OpenRouter key row, holding nothing, with no credits in the Studio`, async () => {
      const fx = await seed(0);
      const llmKeyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

      const { taskId, status } = await acceptedTask(await SUBMIT[lane](fx));

      expect(status).toBe("pending");
      expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: llmKeyId });
      expect(await holdsFor(taskId)).toEqual([]);
      expect(await taskRowText(taskId)).not.toContain(OPENROUTER_KEY);
    });

    it(`${lane}: holds the estimate on our keys, and fails on its row when the credits cannot cover it, as before`, async () => {
      const funded = await seed(100_000);
      const held = await acceptedTask(await SUBMIT[lane](funded));
      expect(held.status).toBe("pending");
      expect((await holdsFor(held.taskId)).length).toBe(1);

      const broke = await seed(0);
      expect((await acceptedTask(await SUBMIT[lane](broke))).status).toBe("failed");
    });

    it(`${lane}: records no key row on our keys`, async () => {
      const fx = await seed(100_000);

      const { taskId } = await acceptedTask(await SUBMIT[lane](fx));

      expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
    });
  }
});

describe("a model mini-tool", () => {
  it("runs its model on the fal key row the payer pointed it at, holding nothing, with no credits in the Studio", async () => {
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, REMOVE_BG, "fal", FAL_KEY);

    const { taskId, status } = await acceptedTask(await SUBMIT.miniTool(fx));

    expect(status).toBe("pending");
    expect(await keyColumns(taskId)).toEqual({ key_id: keyId, llm_key_id: null });
    expect(await holdsFor(taskId)).toEqual([]);
    expect(await taskRowText(taskId)).not.toContain(FAL_KEY);
  });

  it("holds the estimate on our keys, and fails on its rows when the credits cannot cover it, as before", async () => {
    const funded = await seed(100_000);
    const held = await acceptedTask(await SUBMIT.miniTool(funded));
    expect(held.status).toBe("pending");
    expect((await holdsFor(held.taskId)).length).toBe(1);

    const broke = await seed(0);
    expect((await acceptedTask(await SUBMIT.miniTool(broke))).status).toBe("failed");
  });

  it("records no key row on our keys", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await SUBMIT.miniTool(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
  });

  it("accepts its model on the payer's key when the deployment has none", async () => {
    deploy();
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, REMOVE_BG, "fal", FAL_KEY);

    const { taskId, status } = await acceptedTask(await SUBMIT.miniTool(fx));

    expect(status).toBe("pending");
    expect((await keyColumns(taskId)).key_id).toBe(keyId);
  });
});

describe("a 3D generation", () => {
  it("runs a model the payer pointed at WaveSpeed on that key row, holding nothing, with no credits in the Studio", async () => {
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, T23D, "wavespeed", WAVESPEED_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.threeD(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: keyId, llm_key_id: null });
    expect(await holdsFor(taskId)).toEqual([]);
    expect(await taskRowText(taskId)).not.toContain(WAVESPEED_KEY);
  });

  it("holds the estimate on our keys, and refuses what the credits cannot cover, as before", async () => {
    const funded = await seed(100_000);
    const { taskId } = await acceptedTask(await SUBMIT.threeD(funded));
    expect((await holdsFor(taskId)).length).toBe(1);

    const broke = await seed(0);
    expect((await SUBMIT.threeD(broke)).status).toBe(402);
  });

  it("records no key row on our keys", async () => {
    const fx = await seed(100_000);

    const { taskId } = await acceptedTask(await SUBMIT.threeD(fx));

    expect(await keyColumns(taskId)).toEqual({ key_id: null, llm_key_id: null });
  });

  it("accepts a model the deployment has no key for when the payer's key can run it", async () => {
    deploy();
    const fx = await seed(0);
    const keyId = await pointAt(fx.userId, T23D, "wavespeed", WAVESPEED_KEY);

    const { taskId } = await acceptedTask(await SUBMIT.threeD(fx));

    expect((await keyColumns(taskId)).key_id).toBe(keyId);
  });
});

describe("a Timeline web-animation execution", () => {
  /**
   * Ask to accept an execution.
   * @param fx - Where.
   * @returns The response.
   */
  const acceptExecution = (fx: Fixture): Promise<Response> =>
    post(fx, "/timeline/executions", {
      projectId: fx.projectId,
      spaceId: fx.spaceId,
      actionId: crypto.randomUUID(),
      prompt: "A red square slides in from the left",
      engine: "deepseek",
      aspect: "16:9",
      durationSeconds: 4,
      fps: { num: 24, den: 1 },
    });

  /**
   * The execution an accepted request answered with, and its stored key row.
   * @param res - The response.
   * @returns Its id and `llm_key_id`.
   */
  const acceptedExecution = async (res: Response): Promise<{ id: string; llmKeyId: string | null }> => {
    expect(res.status, await res.clone().text()).toBe(201);
    const { id } = ((await res.json()) as { data: { id: string } }).data;
    const [row] = await sql<{ llm_key_id: string | null }[]>`SELECT llm_key_id FROM timeline_executions WHERE id = ${id}`;
    return { id, llmKeyId: row!.llm_key_id };
  };

  it("records the payer's OpenRouter key row at acceptance, and never the key", async () => {
    const fx = await seed(10_000, "timeline");
    const keyId = await saveKey(fx.userId, "openrouter", OPENROUTER_KEY);

    const { id, llmKeyId } = await acceptedExecution(await acceptExecution(fx));

    expect(llmKeyId).toBe(keyId);
    expect(JSON.stringify(await sql`SELECT * FROM timeline_executions WHERE id = ${id}`)).not.toContain(OPENROUTER_KEY);
  });

  it("records no key row when the payer has no OpenRouter key", async () => {
    const fx = await seed(10_000, "timeline");
    await saveKey(fx.userId, "fal", FAL_KEY);

    expect((await acceptedExecution(await acceptExecution(fx))).llmKeyId).toBeNull();
  });
});
