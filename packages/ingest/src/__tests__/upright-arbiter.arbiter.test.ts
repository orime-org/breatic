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
import { uprightObjectUrl } from "@ingest/upright-run.js";
import { writeUprightVia, type UprightWrite } from "@ingest/upright-write.js";

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
  return {
    kind,
    storageKey: key,
    receivedSha256: RECEIVED,
    lossless: false,
    contentType: "image/png",
    quality: 90,
    toolTimeoutMs: 1_000,
    waitBy: Date.now() + waitMs,
  };
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

  describe("the write-back handler", () => {
    function contextFor(key: string): { containerId: string; className: string; params: UprightWrite } {
      return {
        containerId: "host",
        className: "MediaContainer",
        params: { key, receivedSha256: RECEIVED, httpMetadata: { contentType: "image/png" } },
      };
    }

    it("stages the body with the original metadata and the mark, then has the arbiter complete it", async () => {
      const { key, stub } = await seeded();
      await stub.setScript("holdsUntilReleased");
      const asked = stub.ask(askFor(key));
      const handler = writeUprightVia(() => stub);
      const answered = await handler(
        new Request(uprightObjectUrl(key), { method: "PUT", body: UPRIGHT_BYTES }),
        { BUCKET: host.BUCKET },
        contextFor(key),
      );
      expect(answered.status).toBe(200);
      expect(await bodyOf(key)).toEqual({ text: "upright bytes", type: "image/png", mark: RECEIVED });
      await stub.release();
      expect((await asked).phase).toBe("done");
    });

    it("answers 409 and leaves the object alone once the key is abandoned", async () => {
      const { key, stub } = await seeded();
      await stub.ask(askFor(key, "seal"));
      const handler = writeUprightVia(() => stub);
      const answered = await handler(
        new Request(uprightObjectUrl(key), { method: "PUT", body: UPRIGHT_BYTES }),
        { BUCKET: host.BUCKET },
        contextFor(key),
      );
      expect(answered.status).toBe(409);
      expect(await bodyOf(key)).toEqual({ text: "original bytes", type: "image/png", mark: undefined });
    });

    it("refuses a key other than the one it was set for", async () => {
      const { key, stub } = await seeded();
      const handler = writeUprightVia(() => stub);
      const answered = await handler(
        new Request(uprightObjectUrl(`${key}.other`), { method: "PUT", body: UPRIGHT_BYTES }),
        { BUCKET: host.BUCKET },
        contextFor(key),
      );
      expect(answered.status).toBe(403);
    });

    it("refuses anything but a PUT", async () => {
      const { key, stub } = await seeded();
      const handler = writeUprightVia(() => stub);
      const answered = await handler(new Request(uprightObjectUrl(key)), { BUCKET: host.BUCKET }, contextFor(key));
      expect(answered.status).toBe(405);
    });
  });
});
