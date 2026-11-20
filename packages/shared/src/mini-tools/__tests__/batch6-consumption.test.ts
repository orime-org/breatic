// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type ConsumptionIdentity =
  | { kind: "provider"; stepId: string }
  | { kind: "container"; containerClass: string; jobId: string; chunkIndex: number };

interface ConsumptionApi {
  miniToolConsumptionIdentitySchema: {
    parse: (input: unknown) => ConsumptionIdentity;
    safeParse: (input: unknown) => { success: boolean };
  };
  miniToolConsumptionKey: (input: { taskId: string; stepId: string; identity: ConsumptionIdentity }) => string | Promise<string>;
}

// Missing exports fail the public-entry assertion without preventing collection.
const api = miniTools as unknown as ConsumptionApi;
const scope = { taskId: "10000000-0000-4000-8000-000000000001", stepId: "20000000-0000-4000-8000-000000000001" };
// A model step is identified by its own step row (inner#1306 execution design §11.4).
const provider: ConsumptionIdentity = { kind: "provider", stepId: scope.stepId };
const container: ConsumptionIdentity = { kind: "container", containerClass: "media-standard", jobId: "job-001", chunkIndex: 0 };

describe("batch six consumption identity and key", () => {
  it("exports both public entry points", () => {
    expect(["miniToolConsumptionIdentitySchema", "miniToolConsumptionKey"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  it.each([provider, container])("preserves the complete $kind identity", (identity) => {
    expect(api.miniToolConsumptionIdentitySchema.parse(identity)).toEqual(identity);
  });

  it.each([
    { kind: "provider" },
    { ...provider, stepId: "" },
    { ...provider, stepId: "not-a-uuid" },
    { kind: "provider", provider: "wavespeed", predictionId: "prediction-001" },
    { ...provider, containerClass: "media-standard", jobId: "job-001", chunkIndex: 0 },
    { kind: "container", jobId: "job-001", chunkIndex: 0 },
    { kind: "container", containerClass: "media-standard", chunkIndex: 0 },
    { kind: "container", containerClass: "media-standard", jobId: "job-001" },
    { ...container, containerClass: "" },
    { ...container, jobId: "" },
    { ...container, chunkIndex: -1 },
    { ...container, chunkIndex: 0.5 },
    { ...container, chunkIndex: Number.NaN },
    { ...container, chunkIndex: Number.POSITIVE_INFINITY },
    { ...container, predictionId: "prediction-001" },
  ])("rejects incomplete or mixed identity %#", (identity) => {
    expect(api.miniToolConsumptionIdentitySchema.safeParse(identity).success).toBe(false);
  });

  it.each([provider, container])("scopes the $kind key to task and step", async (identity) => {
    const key = await api.miniToolConsumptionKey({ ...scope, identity });
    expect(await api.miniToolConsumptionKey({ ...scope, identity: structuredClone(identity) })).toBe(key);
    expect(await api.miniToolConsumptionKey({ ...scope, taskId: "10000000-0000-4000-8000-000000000002", identity })).not.toBe(key);
    expect(await api.miniToolConsumptionKey({ ...scope, stepId: "20000000-0000-4000-8000-000000000002", identity })).not.toBe(key);
    const parsed = api.miniToolConsumptionIdentitySchema.parse(JSON.parse(JSON.stringify(identity)) as unknown);
    expect(parsed).toEqual(identity);
    expect(await api.miniToolConsumptionKey({ ...scope, identity: parsed })).toBe(key);
  });

  it("includes each actual upstream identity field", async () => {
    const providerKey = await api.miniToolConsumptionKey({ ...scope, identity: provider });
    expect(await api.miniToolConsumptionKey({ ...scope, identity: { ...provider, stepId: "20000000-0000-4000-8000-000000000002" } })).not.toBe(providerKey);
    const containerKey = await api.miniToolConsumptionKey({ ...scope, identity: container });
    for (const identity of [{ ...container, containerClass: "media-large" }, { ...container, jobId: "job-002" }, { ...container, chunkIndex: 1 }]) {
      expect(await api.miniToolConsumptionKey({ ...scope, identity })).not.toBe(containerKey);
    }
    expect(await api.miniToolConsumptionKey({ ...scope, identity: { ...container, jobId: "prediction-001" } })).not.toBe(providerKey);
  });

  it("normalizes identity key insertion order", async () => {
    expect(await api.miniToolConsumptionKey({ ...scope, identity: { stepId: scope.stepId, kind: "provider" } })).toBe(await api.miniToolConsumptionKey({ ...scope, identity: provider }));
    expect(await api.miniToolConsumptionKey({ ...scope, identity: { chunkIndex: 0, jobId: "job-001", containerClass: "media-standard", kind: "container" } })).toBe(await api.miniToolConsumptionKey({ ...scope, identity: container }));
  });

  it.each(["taskId", "stepId"].flatMap((field) => ["", undefined, "not-a-uuid", 7, null].map((value) => ({ field, value }))))("rejects invalid scope $field=$value before constructing a consumption key", async ({ field, value }) => {
    const invalid = { ...scope, identity: provider, [field]: value } as unknown as Parameters<ConsumptionApi["miniToolConsumptionKey"]>[0];
    await expect(Promise.resolve().then(() => api.miniToolConsumptionKey(invalid))).rejects.toThrow();
  });

  it.each([
    [provider, "6be748b9e9861bdb4fe2e0f49a4799824f89dd795967f8186e9a2240222e45cd"],
    [container, "c407fd846a6fa2272ba9d1b59b0e2050538e3a077685d79d9e7d11074d825944"],
  ] as const)("matches the independent version-one $0.kind consumption key golden value", async (identity, expected) => {
    expect(await api.miniToolConsumptionKey({ ...scope, identity })).toBe(expected);
  });

  it("keeps valid identities and keys stable through serialization", async () => {
    const identityArbitrary: fc.Arbitrary<ConsumptionIdentity> = fc.oneof(
      fc.record({ kind: fc.constant("provider" as const), stepId: fc.uuid() }),
      fc.record({ kind: fc.constant("container" as const), containerClass: fc.constantFrom("media-standard", "media-large"), jobId: fc.uuid(), chunkIndex: fc.nat() }),
    );
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), identityArbitrary, async (taskId, stepId, identity) => {
      const parsed = api.miniToolConsumptionIdentitySchema.parse(JSON.parse(JSON.stringify(identity)) as unknown);
      expect(parsed).toEqual(identity);
      expect(await api.miniToolConsumptionKey({ taskId, stepId, identity: parsed })).toBe(await api.miniToolConsumptionKey({ taskId, stepId, identity }));
    }));
  });
});
