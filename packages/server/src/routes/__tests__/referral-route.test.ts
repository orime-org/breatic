// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The account's referral routes (inner#1868 §7, §8): what they refuse, how a
 * service refusal reaches the browser, and that every endpoint is throttled.
 * The services are stubbed; this file asserts the route layer only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { referral, application, rateLimitFor, envRef } = vi.hoisted(() => ({
  referral: { readAccountReferral: vi.fn(), bindLater: vi.fn() },
  application: { submitApplication: vi.fn() },
  rateLimitFor: vi.fn(),
  envRef: { PAYMENT_ENABLED: true },
}));

vi.mock("@server/modules/referral/referral.service.js", () => referral);
vi.mock("@server/modules/referral/promoter-application.service.js", () => application);
vi.mock("@server/config/legal.js", () => ({ getLegalConfig: () => ({ terms_version: "2026-10-02", promoter_terms_version: "2026-11-07" }) }));
vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: (...args: unknown[]) => {
    rateLimitFor(...args);
    return async (_c: unknown, next: () => Promise<void>) => next();
  },
}));
vi.mock("@server/middleware/run-once.js", () => ({
  runOnce: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u-1" });
    return next();
  },
}));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  env: envRef,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { Hono } from "hono";
import { initCore, loadLocales } from "@breatic/core";
import { errorHandler } from "@server/middleware/error-handler.js";
import { referralRoute } from "@server/routes/referral.js";

try {
  initCore(process.env);
} catch {
  // Initialised by another file in this worker.
}
loadLocales();

const app = new Hono();
app.route("/", referralRoute);
app.onError(errorHandler);

const VIEW = { firstPeriodDiscountPercent: 20, binding: null, canBind: true, program: { open: true, termsVersion: "2026-11-07" }, promoter: { state: "none" } };
const FORM = { country: "SG", channels: ["https://youtube.com/@me"], plan: "Tutorials", termsVersion: "2026-11-07" };
const KEY = { "idempotency-key": "00000000-0000-4000-8000-000000000001" };

/**
 * Sends one request at the route.
 * @param method - GET or POST.
 * @param path - The endpoint under `/`.
 * @param body - The JSON body, for a POST.
 * @returns The response.
 */
async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", ...KEY },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const rateLimitCalls = [...rateLimitFor.mock.calls];

beforeEach(() => {
  vi.clearAllMocks();
  envRef.PAYMENT_ENABLED = true;
  referral.readAccountReferral.mockResolvedValue(VIEW);
});

describe("referral routes while payments are off", () => {
  it.each([
    ["GET", "/", undefined],
    ["POST", "/binding", { code: "ALICE" }],
    ["POST", "/applications", FORM],
  ] as const)("%s %s answers 404 and does nothing", async (method, path, body) => {
    envRef.PAYMENT_ENABLED = false;
    expect((await send(method, path, body)).status).toBe(404);
    expect(referral.readAccountReferral).not.toHaveBeenCalled();
    expect(referral.bindLater).not.toHaveBeenCalled();
    expect(application.submitApplication).not.toHaveBeenCalled();
  });
});

describe("GET /account/referral", () => {
  it("answers the panel's view read against the current promoter terms", async () => {
    const res = await send("GET", "/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: VIEW });
    expect(referral.readAccountReferral).toHaveBeenCalledWith("u-1", "2026-11-07");
  });
});

describe("POST /account/referral/binding", () => {
  it("binds and answers the fresh view", async () => {
    referral.bindLater.mockResolvedValue({ ok: true });
    const res = await send("POST", "/binding", { code: " alice " });
    expect(res.status).toBe(200);
    expect(referral.bindLater).toHaveBeenCalledWith("u-1", " alice ");
    expect(await res.json()).toEqual({ data: VIEW });
  });

  it.each(["invalid_code", "already_bound", "already_paid", "not_eligible"])("answers 422 with reason %s", async (reason) => {
    referral.bindLater.mockResolvedValue({ ok: false, reason });
    const res = await send("POST", "/binding", { code: "ALICE" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { reason: string; message: string } };
    expect(body.error.reason).toBe(reason);
    expect(body.error.message).not.toBe("");
  });

  it.each([{}, { code: "" }, { code: "x".repeat(41) }])("refuses %j as malformed", async (body) => {
    expect((await send("POST", "/binding", body)).status).toBe(422);
    expect(referral.bindLater).not.toHaveBeenCalled();
  });
});

describe("POST /account/referral/applications", () => {
  it("files the application against the current terms and answers the fresh view", async () => {
    application.submitApplication.mockResolvedValue({ ok: true });
    const res = await send("POST", "/applications", FORM);
    expect(res.status).toBe(200);
    expect(application.submitApplication).toHaveBeenCalledWith("u-1", FORM, "2026-11-07");
    expect(await res.json()).toEqual({ data: VIEW });
  });

  it.each(["program_closed", "application_pending", "already_promoter"])("answers 409 with reason %s", async (reason) => {
    application.submitApplication.mockResolvedValue({ ok: false, reason });
    const res = await send("POST", "/applications", FORM);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe(reason);
  });

  it("answers 409 terms_changed with the current version", async () => {
    application.submitApplication.mockResolvedValue({ ok: false, reason: "terms_changed", termsVersion: "2026-12-01" });
    const res = await send("POST", "/applications", FORM);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { reason: string; termsVersion: string } }).error).toMatchObject({
      reason: "terms_changed", termsVersion: "2026-12-01",
    });
  });

  it.each([
    { ...FORM, country: "sg" },
    { ...FORM, channels: [] },
    { ...FORM, channels: Array.from({ length: 11 }, () => "x") },
    { ...FORM, channels: ["x".repeat(201)] },
    { ...FORM, plan: "" },
    { ...FORM, plan: "x".repeat(2001) },
    { ...FORM, termsVersion: "" },
  ])("refuses a malformed form", async (body) => {
    expect((await send("POST", "/applications", body)).status).toBe(422);
    expect(application.submitApplication).not.toHaveBeenCalled();
  });
});

describe("referral route throttling", () => {
  it("throttles reading, binding and applying per account", () => {
    const actions = rateLimitCalls.map(([action, keyBy]) => `${String(action)}:${String(keyBy)}`);
    expect(actions).toEqual(expect.arrayContaining(["referral-read:user", "referral-bind:user", "promoter-apply:user"]));
  });
});
