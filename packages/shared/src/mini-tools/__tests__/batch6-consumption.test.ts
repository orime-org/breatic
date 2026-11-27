// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as miniTools from "@shared/mini-tools/index.js";

type ConsumptionIdentity = { kind: "container"; containerClass: string; jobId: string; chunkIndex: number };

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
const container: ConsumptionIdentity = { kind: "container", containerClass: "media-standard", jobId: "job-001", chunkIndex: 0 };

describe("batch six consumption identity and key", () => {
  it("exports both public entry points", () => {
    expect(["miniToolConsumptionIdentitySchema", "miniToolConsumptionKey"].filter((key) => !(key in miniTools))).toEqual([]);
  });

  it.each([container])("preserves the complete $kind identity", (identity) => {
    expect(api.miniToolConsumptionIdentitySchema.parse(identity)).toEqual(identity);
  });

  it.each([
    { kind: "provider", stepId: scope.stepId },
    { kind: "provider", provider: "wavespeed", predictionId: "prediction-001" },
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

  it.each([container])("scopes the $kind key to task and step", async (identity) => {
    const key = await api.miniToolConsumptionKey({ ...scope, identity });
    expect(await api.miniToolConsumptionKey({ ...scope, identity: structuredClone(identity) })).toBe(key);
    expect(await api.miniToolConsumptionKey({ ...scope, taskId: "10000000-0000-4000-8000-000000000002", identity })).not.toBe(key);
    expect(await api.miniToolConsumptionKey({ ...scope, stepId: "20000000-0000-4000-8000-000000000002", identity })).not.toBe(key);
    const parsed = api.miniToolConsumptionIdentitySchema.parse(JSON.parse(JSON.stringify(identity)) as unknown);
    expect(parsed).toEqual(identity);
    expect(await api.miniToolConsumptionKey({ ...scope, identity: parsed })).toBe(key);
  });

  it("includes each actual upstream identity field", async () => {
    const containerKey = await api.miniToolConsumptionKey({ ...scope, identity: container });
    for (const identity of [{ ...container, containerClass: "media-large" }, { ...container, jobId: "job-002" }, { ...container, chunkIndex: 1 }]) {
      expect(await api.miniToolConsumptionKey({ ...scope, identity })).not.toBe(containerKey);
    }
  });

  it("normalizes identity key insertion order", async () => {
    expect(await api.miniToolConsumptionKey({ ...scope, identity: { chunkIndex: 0, jobId: "job-001", containerClass: "media-standard", kind: "container" } })).toBe(await api.miniToolConsumptionKey({ ...scope, identity: container }));
  });

  it.each(["taskId", "stepId"].flatMap((field) => ["", undefined, "not-a-uuid", 7, null].map((value) => ({ field, value }))))("rejects invalid scope $field=$value before constructing a consumption key", async ({ field, value }) => {
    const invalid = { ...scope, identity: container, [field]: value };
    await expect(Promise.resolve().then(() => api.miniToolConsumptionKey(invalid))).rejects.toThrow();
  });

  it.each([
    [container, "c407fd846a6fa2272ba9d1b59b0e2050538e3a077685d79d9e7d11074d825944"],
  ] as const)("matches the independent version-one $0.kind consumption key golden value", async (identity, expected) => {
    expect(await api.miniToolConsumptionKey({ ...scope, identity })).toBe(expected);
  });

  it("keeps valid identities and keys stable through serialization", async () => {
    const identityArbitrary: fc.Arbitrary<ConsumptionIdentity> = fc.record({
      kind: fc.constant("container" as const), containerClass: fc.constantFrom("media-standard", "media-large"), jobId: fc.uuid(), chunkIndex: fc.nat(),
    });
    await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), identityArbitrary, async (taskId, stepId, identity) => {
      const parsed = api.miniToolConsumptionIdentitySchema.parse(JSON.parse(JSON.stringify(identity)) as unknown);
      expect(parsed).toEqual(identity);
      expect(await api.miniToolConsumptionKey({ taskId, stepId, identity: parsed })).toBe(await api.miniToolConsumptionKey({ taskId, stepId, identity }));
    }));
  });
});
