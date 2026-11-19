// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "vitest";
import { createServerApi, ServerApiError } from "@mcp/server-api.js";
import { startFakeServer, type FakeAnswer, type FakeServer, type SeenRequest } from "@mcp/__tests__/fake-server.js";

let fake: FakeServer | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/**
 * A client over a fake server.
 * @param answer - What the server answers.
 * @returns The client.
 */
async function apiOver(answer: (req: SeenRequest) => FakeAnswer): Promise<ReturnType<typeof createServerApi>> {
  fake = await startFakeServer(answer);
  return createServerApi({ baseUrl: fake.baseUrl, token: "downstream-token", deadlineAt: Date.now() + 5_000 });
}

describe("createServerApi", () => {
  it("calls as the user with the downstream token and returns the data inside the envelope", async () => {
    const api = await apiOver(() => ({ status: 200, body: { data: [{ id: "s1" }] } }));
    expect(await api.get("/studios")).toEqual([{ id: "s1" }]);
    expect(fake!.seen[0]).toMatchObject({ method: "GET", path: "/studios" });
    expect(fake!.seen[0]!.headers.authorization).toBe("Bearer downstream-token");
  });

  it("repeats a query key for each value of a list and leaves out undefined ones", async () => {
    const api = await apiOver(() => ({ status: 200, body: { data: { items: [] } } }));
    await api.get("/assets/upload-status", { key: ["a", "b"], other: undefined });
    expect(fake!.seen[0]!.query.getAll("key")).toEqual(["a", "b"]);
    expect(fake!.seen[0]!.query.has("other")).toBe(false);
  });

  it("posts JSON with the idempotency key and extra headers it is given", async () => {
    const api = await apiOver(() => ({ status: 201, body: { data: { task_id: "t1", status: "pending" } } }));
    expect(await api.post("/canvas/tasks", { a: 1 }, { idempotencyKey: "k-1", headers: { "x-upload-token": "tok" } })).toEqual({ task_id: "t1", status: "pending" });
    const seen = fake!.seen[0]!;
    expect(seen.body).toEqual({ a: 1 });
    expect(seen.headers["idempotency-key"]).toBe("k-1");
    expect(seen.headers["x-upload-token"]).toBe("tok");
    expect(seen.headers["content-type"]).toBe("application/json");
  });

  it("throws the server's status, message and reason", async () => {
    const api = await apiOver(() => ({ status: 402, body: { error: { code: 402, message: "Insufficient credits: required 5, available 1" } } }));
    const err = await api.post("/canvas/tasks", {}, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerApiError);
    expect(err).toMatchObject({ status: 402, message: "Insufficient credits: required 5, available 1" });
  });

  it("reads an error body without a code field", async () => {
    const api = await apiOver(() => ({ status: 409, body: { error: { message: "Conflict" } } }));
    await expect(api.post("/assets/uploads/u/complete", { parts: [] })).rejects.toMatchObject({ status: 409, message: "Conflict" });
  });

  it("keeps the request-shape reason and the wait a 429 asks for", async () => {
    const api = await apiOver((req) =>
      req.path === "/a"
        ? { status: 422, body: { error: { code: 422, message: "Invalid input", reason: "request_shape" } } }
        : { status: 429, body: { error: { code: 429, message: "Too many requests" } }, headers: { "retry-after": "0" } },
    );
    await expect(api.get("/a")).rejects.toMatchObject({ status: 422, reason: "request_shape" });
    await expect(api.post("/b", {}, { idempotencyKey: "k" })).rejects.toMatchObject({ status: 429, retryAfterSeconds: 0 });
  });

  it("gives up at the call's deadline", async () => {
    fake = await startFakeServer(() => ({ status: 200, body: { data: 1 } }));
    const api = createServerApi({ baseUrl: fake.baseUrl, token: "t", deadlineAt: Date.now() - 1 });
    await expect(api.get("/studios")).rejects.toMatchObject({ status: 503 });
  });
});
