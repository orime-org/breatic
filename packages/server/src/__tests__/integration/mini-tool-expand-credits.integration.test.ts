// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Model mini-tools' credit precheck (expand: inner#1303 A11, design §8; the
 * batch-four tools: inner#1304 §6.6): a run is checked against its pinned
 * model's own price before it is queued, against the credits designated to
 * the project's studio. Driven through `POST
 * /api/v1/mini-tools` on a real database and Redis.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// Fulfilment asks Stripe what the session is; every fixture payment is 1000 / usd.
const stripe = {
  checkout: {
    sessions: {
      retrieve: vi.fn(async (id: string) => ({
        id,
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_subtotal: 1000,
        amount_total: 1000,
        currency: "usd",
        total_details: { amount_tax: 0 },
        payment_intent: `pi_${id}`,
        metadata: {},
      })),
    },
  },
};

vi.mock("@server/infra/stripe.js", () => ({
  getStripeClient: () => stripe,
}));

import crypto from "node:crypto";
import type { Hono } from "hono";
import postgres from "postgres";
import { initCore, loadLocales, getRedis, setSession, sessionCookieName } from "@breatic/core";
import { estimateTaskCredits } from "@breatic/domain";
import { miniToolById, miniToolEstimateInput } from "@breatic/shared/mini-tools";
import * as paymentService from "@server/modules/payment/payment.service.js";

const PG_DRIVER_LOCAL = "mini-tool-expand-credits-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;

beforeAll(async () => {
  initCore({
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    // The catalog serves a model only when its provider has a key; nothing here
    // reaches the provider, the run stops at the queue.
    WAVESPEED_API_KEY: "unused_by_this_suite",
  });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  // `@server/app.js` reads `env.ALLOWED_ORIGINS` as it loads, so after initCore.
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  initCore(process.env);
});

/**
 * A user who administers a studio, a project in it, a signed-in session, and
 * the given credits designated to the studio.
 * @param credits - The credits to designate.
 * @returns The project, the cookie and the user.
 */
async function seed(credits: number): Promise<{ projectId: string; cookie: string }> {
  const n = seq++;
  const stamp = Date.now();
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`expand-${n}-${stamp}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`expand-s-${n}-${stamp}`}, 'team', 'Expand') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studio!.id}, ${userId}, ${`expand-p-${n}-${stamp}`}, 'Expand') RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${project!.id}, ${userId}, 'owner')`;
  if (credits > 0) {
    const sessionId = `cs_test_expand_${n}_${stamp}`;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO credit_sources (id, kind) VALUES (gen_random_uuid(), 'payment') RETURNING id
    `;
    await sql`
      INSERT INTO payments (id, user_id, stripe_session_id, amount_cents, status, credits_granted)
      VALUES (${source!.id}, ${userId}, ${sessionId}, 1000, 'pending', ${credits})
    `;
    await paymentService.fulfillPayment(sessionId, { id: `evt_expand_${n}_${stamp}`, type: "checkout.session.completed" });
    await sql`UPDATE credit_lots SET designated_studio_id = ${studio!.id} WHERE user_id = ${userId}`;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { projectId: project!.id, cookie: `${sessionCookieName()}=${token}` };
}

/** An expand request on one node. */
const EXPAND = {
  tool: "image.expand",
  source: { url: "https://assets.example.com/i/a.png" },
  slots: {},
  params: {},
  prompt: "",
  expand: { image: "https://assets.example.com/i/padded.png", mask: "https://assets.example.com/i/mask.png" },
};

/**
 * What one expand run costs, by the fill model's own estimate.
 * @returns The credits.
 */
async function expandPrice(): Promise<number> {
  const spec = miniToolById("image.expand")!;
  return estimateTaskCredits("bria-genfill", miniToolEstimateInput(spec, { params: {}, prompt: "", source: EXPAND.source, slots: {} }));
}

/**
 * Run the expand tool in a fresh Space.
 * @param projectId - The project.
 * @param cookie - The session cookie.
 * @returns The task id and the status the server answered.
 */
async function runExpand(projectId: string, cookie: string): Promise<{ taskId: string; status: string }> {
  const res = await app.request("/api/v1/mini-tools", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ ...EXPAND, project_id: projectId, space_id: crypto.randomUUID(), node_ids: [crypto.randomUUID()] }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = (await res.json()) as { data: { task_id: string; status: string } };
  return { taskId: body.data.task_id, status: body.data.status };
}

describe("the expand tool's credit precheck", () => {
  it("prices a run at the fill model's own estimate", async () => {
    expect(await expandPrice()).toBeGreaterThan(0);
  });

  it("refuses a run one credit short of that price, failing its task as no credits", async () => {
    const { projectId, cookie } = await seed((await expandPrice()) - 1);
    const { taskId, status } = await runExpand(projectId, cookie);
    expect(status).toBe("failed");
    const [task] = await sql<{ status: string; error: string | null }[]>`SELECT status, error_message AS error FROM tasks WHERE id = ${taskId}`;
    expect(task).toEqual({ status: "failed", error: "no_credits" });
  });

  it("queues a run the designated credits cover exactly", async () => {
    const { projectId, cookie } = await seed(await expandPrice());
    const { status } = await runExpand(projectId, cookie);
    expect(status).toBe("pending");
  });
});

// inner#1304: the batch-four tools are priced and checked the same way, each at
// its pinned model's own estimate.
const SOURCE = { url: "https://assets.example.com/i/a.png", width: 768, height: 1152 };
const STYLE = (n: number): { url: string }[] => Array.from({ length: n }, (_, i) => ({ url: `https://assets.example.com/i/s${i}.png` }));
const BATCH_FOUR: Record<string, { model: string; body: Record<string, unknown> }> = {
  "image.angle": {
    model: "qwen-image-edit-multiple-angles",
    body: { params: { horizontal_angle: 90, vertical_angle: 30, distance: 1 }, prompt: "", slots: {} },
  },
  "image.relight": {
    model: "nano-banana-2-relight",
    body: { params: { light_color: "custom", light_color_hex: "#8fc0ff", light_intensity: "high", resolution: "2k" }, prompt: "", slots: {} },
  },
  "image.restyle": { model: "gpt-image-2.5-sunburst-edit", body: { params: { resolution: "2k" }, prompt: "", slots: { style: STYLE(1) } } },
  "image.quickEdit": { model: "nano-banana-2-quick-edit", body: { params: { resolution: "2k" }, prompt: "make it night", slots: {} } },
};

/**
 * What one run of a batch-four tool costs, by its pinned model's own estimate.
 * @param tool - The tool id.
 * @param body - The request body's params, prompt and slots.
 * @returns The credits.
 */
async function toolPrice(tool: string, body: Record<string, unknown>): Promise<number> {
  const spec = miniToolById(tool)!;
  const { params, prompt, slots } = body as { params: Record<string, unknown>; prompt: string; slots: Record<string, { url: string }[]> };
  return estimateTaskCredits(BATCH_FOUR[tool]!.model, miniToolEstimateInput(spec, { params, prompt, source: SOURCE, slots }));
}

/**
 * Run a batch-four tool in a fresh Space.
 * @param tool - The tool id.
 * @param body - The request body's params, prompt and slots.
 * @param projectId - The project.
 * @param cookie - The session cookie.
 * @returns The HTTP status, and the task id and status on success.
 */
async function runTool(
  tool: string,
  body: Record<string, unknown>,
  projectId: string,
  cookie: string,
): Promise<{ http: number; taskId?: string; status?: string }> {
  const res = await app.request("/api/v1/mini-tools", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ tool, source: SOURCE, ...body, project_id: projectId, space_id: crypto.randomUUID(), node_ids: [crypto.randomUUID()] }),
  });
  if (res.status !== 201) return { http: res.status };
  const json = (await res.json()) as { data: { task_id: string; status: string } };
  return { http: 201, taskId: json.data.task_id, status: json.data.status };
}

/**
 * The fewest credits a lot can hold that cover a price: lots keep six decimals,
 * and an estimate can carry float noise past them (inner#1637).
 * @param price - The estimate.
 * @returns The credits, rounded up to the lot's scale.
 */
const covering = (price: number): number => Math.ceil(price * 1e6) / 1e6;

describe.each(Object.keys(BATCH_FOUR))("the %s credit precheck", (tool) => {
  const { body } = BATCH_FOUR[tool]!;

  it("refuses a run one credit short of its model's price, and queues one the credits cover exactly", async () => {
    const price = await toolPrice(tool, body);
    expect(price).toBeGreaterThan(0);
    const short = await seed(covering(price) - 1);
    const refused = await runTool(tool, body, short.projectId, short.cookie);
    expect(refused.status).toBe("failed");
    const [task] = await sql<{ error: string | null }[]>`SELECT error_message AS error FROM tasks WHERE id = ${refused.taskId!}`;
    expect(task?.error).toBe("no_credits");
    const enough = await seed(covering(price));
    const queued = await runTool(tool, body, enough.projectId, enough.cookie);
    const [row] = await sql<{ error: string | null }[]>`SELECT error_message AS error FROM tasks WHERE id = ${queued.taskId!}`;
    expect(queued.status, `${tool} at ${price}: ${row?.error}`).toBe("pending");
  });
});

describe("the batch-four runs the server prices and refuses", () => {
  it("prices each style picture past the first, after the slot joins the model's pictures", async () => {
    const one = await toolPrice("image.restyle", BATCH_FOUR["image.restyle"]!.body);
    const three = await toolPrice("image.restyle", { ...BATCH_FOUR["image.restyle"]!.body, slots: { style: STYLE(3) } });
    expect(three).toBeGreaterThan(one);
    // Three pictures cost what the server charges: credits for one picture do not queue a three-picture run.
    const { projectId, cookie } = await seed(one);
    const run = await runTool("image.restyle", { ...BATCH_FOUR["image.restyle"]!.body, slots: { style: STYLE(3) } }, projectId, cookie);
    expect(run.status).toBe("failed");
  });

  it("refuses a light colour the catalog does not offer, before any task opens", async () => {
    const { projectId, cookie } = await seed(0);
    const run = await runTool("image.relight", { ...BATCH_FOUR["image.relight"]!.body, params: { light_color: "golden" } }, projectId, cookie);
    expect(run.http).toBe(400);
  });
});
