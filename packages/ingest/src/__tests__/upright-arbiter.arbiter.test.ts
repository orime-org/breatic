// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upright arbiter against a real Durable Object and a real bucket
 * (inner#1367 design §4.4).
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { previewKeyFor } from "@breatic/shared";
import type { ArbiterHost, HostEnv } from "./helpers/arbiter-host.js";
import { MEDIA_DIMENSIONS_STUB, PREVIEW_STUB, UPRIGHT_BYTES } from "./helpers/arbiter-fixtures.js";

const host = env as unknown as HostEnv;
const ORIGINAL = new TextEncoder().encode("original bytes");
const RECEIVED = "a".repeat(64);
let seq = 0;

async function seeded(): Promise<{ key: string; stub: DurableObjectStub<ArbiterHost> }> {
  const key = `image/arbiter-${Date.now()}-${seq++}.png`;
  await host.BUCKET.put(key, ORIGINAL, { httpMetadata: { contentType: "image/png" } });
  return { key, stub: host.ARBITER_HOST.get(host.ARBITER_HOST.idFromName(key)) };
}

function askFor(key: string, kind: "request" | "seal" = "request", waitMs = 5_000) {
  return { kind, storageKey: key, receivedSha256: RECEIVED, lossless: false, waitBy: Date.now() + waitMs };
}

async function bodyOf(key: string): Promise<{ text: string; type: string | undefined; mark: string | undefined }> {
  const object = await host.BUCKET.get(key);
  if (object === null) throw new Error(`no object at ${key}`);
  return {
    text: await object.text(),
    type: object.httpMetadata?.contentType,
    mark: object.customMetadata?.["received-sha256"],
  };
}

describe("upright arbiter", () => {
  it("runs once for two concurrent requests and answers both alike", async () => {
    const { key, stub } = await seeded();
    const [a, b] = await Promise.all([stub.ask(askFor(key)), stub.ask(askFor(key))]);
    expect(a).toEqual({ phase: "done", media: MEDIA_DIMENSIONS_STUB });
    expect(b).toEqual(a);
    expect((await stub.seen()).runs).toBe(1);
    expect(await bodyOf(key)).toEqual({
      text: new TextDecoder().decode(UPRIGHT_BYTES),
      type: "image/png",
      mark: RECEIVED,
    });
    const preview = await host.BUCKET.get(previewKeyFor(key));
    expect(preview && new Uint8Array(await preview.arrayBuffer())).toEqual(PREVIEW_STUB);
  });

  it("leaves the object as received when the run fails, and logs it", async () => {
    const { key, stub } = await seeded();
    await stub.setScript("fails");
    expect(await stub.ask(askFor(key))).toEqual({ phase: "abandoned", media: null });
    expect(await bodyOf(key)).toEqual({ text: "original bytes", type: "image/png", mark: undefined });
    expect((await stub.seen()).logged).toContain("ingest_upright_failed");
  });

  it("aborts a write-back that arrives after a finish gave up", async () => {
    const { key, stub } = await seeded();
    await stub.setScript("holdsUntilReleased");
    expect(await stub.ask(askFor(key, "request", 200))).toEqual({ phase: "abandoned", media: null });
    await stub.release();
    // The held run now stages and commits; the arbiter must refuse it.
    expect(await stub.stageAndCommit({ storageKey: key, receivedSha256: RECEIVED, httpMetadata: { contentType: "image/png" } })).toBe(false);
    expect(await bodyOf(key)).toEqual({ text: "original bytes", type: "image/png", mark: undefined });
  });

  it("seals a key so a later request starts nothing", async () => {
    const { key, stub } = await seeded();
    expect(await stub.ask(askFor(key, "seal"))).toEqual({ phase: "abandoned", media: null });
    expect(await stub.ask(askFor(key))).toEqual({ phase: "abandoned", media: null });
    expect((await stub.seen()).runs).toBe(0);
  });

  it("asks again for an instance while the finish still has time", async () => {
    const { key, stub } = await seeded();
    await stub.setScript("noInstanceTwiceThenCommits");
    expect(await stub.ask(askFor(key))).toEqual({ phase: "done", media: MEDIA_DIMENSIONS_STUB });
    expect((await stub.seen()).runs).toBe(3);
  });

  it("counts a write-back as landed when its complete failed but the object carries the mark", async () => {
    const { key, stub } = await seeded();
    await stub.setScript("holdsUntilReleased");
    const asked = stub.ask(askFor(key));
    // While the run is held the key is running; a write-back completed behind
    // the arbiter's back makes its own complete fail with the object standing.
    expect(await stub.commitAlreadyCompleted({ storageKey: key, receivedSha256: RECEIVED, httpMetadata: { contentType: "image/png" } })).toBe(true);
    await stub.release();
    expect((await asked).phase).toBe("done");
  });
});
