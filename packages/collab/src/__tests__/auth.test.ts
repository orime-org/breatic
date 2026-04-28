/**
 * Unit tests for the Hocuspocus auth hook.
 *
 * Pins four properties:
 *
 *   1. A missing or expired session token → error
 *   2. A session belonging to user A cannot open documents for a
 *      project owned by user B (the High-4 finding)
 *   3. A document name that does not match the expected
 *      `project-{uuid}` pattern is rejected — legacy `/canvas` and
 *      `/node/{id}` sub-paths are no longer recognized
 *   4. A valid session for the project owner is accepted
 *
 * Both Redis and postgres are mocked so the test is hermetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type Redis from "ioredis";
import { createAuthHook } from "../auth.js";

// Mock postgres — we don't want to import a real postgres.js client.
// The template tag is replaced with a function that returns whatever
// we configure the test to return.
let sqlImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
vi.mock("postgres", () => ({
  default: () =>
    (strings: TemplateStringsArray, ...values: unknown[]) =>
      sqlImpl(strings, ...values),
}));

const redisGet = vi.fn();
const mockRedis = { get: redisGet } as unknown as Redis;

describe("createAuthHook", () => {
  beforeEach(() => {
    redisGet.mockReset();
    sqlImpl = vi.fn().mockResolvedValue([]);
  });

  const buildHook = () =>
    createAuthHook({
      redis: mockRedis,
      envPrefix: "test",
      databaseUrl: "postgres://x",
    });

  it("rejects an empty token", async () => {
    const hook = buildHook();
    await expect(hook({ token: "", documentName: "project-abc-123" })).rejects.toThrow(
      /token/i,
    );
  });

  it("rejects an expired / unknown session token", async () => {
    redisGet.mockResolvedValue(null);
    const hook = buildHook();
    await expect(
      hook({ token: "bad-token", documentName: "project-00000000-0000-0000-0000-000000000001" }),
    ).rejects.toThrow(/session/i);
  });

  it("rejects a document name not matching project-{id}", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({ token: "tok", documentName: "random-doc-name" }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects legacy project-{uuid}/canvas document name", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({ token: "tok", documentName: "project-abc-123/canvas" }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects legacy project-{uuid}/node/{id} document name", async () => {
    redisGet.mockResolvedValue("user-1");
    const hook = buildHook();
    await expect(
      hook({ token: "tok", documentName: "project-abc-123/node/xyz" }),
    ).rejects.toThrow(/recognized project format/);
  });

  it("rejects when the authenticated user does not own the project", async () => {
    redisGet.mockResolvedValue("attacker");
    // SQL returns no rows → project is not owned by `attacker`.
    sqlImpl = vi.fn().mockResolvedValue([]);
    const hook = buildHook();

    await expect(
      hook({
        token: "tok",
        documentName: "project-00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/not authorized/);
  });

  it("accepts a valid session for a project-owner", async () => {
    redisGet.mockResolvedValue("user-1");
    sqlImpl = vi.fn().mockResolvedValue([
      { id: "00000000-0000-0000-0000-000000000001" },
    ]);
    const hook = buildHook();

    const ctx = await hook({
      token: "tok",
      documentName: "project-00000000-0000-0000-0000-000000000001",
    });

    expect(ctx).toEqual({ user: { id: "user-1" } });
  });
});
