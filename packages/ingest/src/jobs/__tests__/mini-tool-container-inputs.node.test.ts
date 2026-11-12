// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which stored objects a mini-tool job's container may read (inner#1825 §6.4).
 * A join reads its source and every further clip, so the job object lets the
 * container read each key the job's inputs name, hands the container their
 * addresses in order, and still refuses every other key with 403.
 *
 * The `Container` base class needs a runtime with containers enabled, which
 * neither test pool has, so it is replaced here by a stand-in that records
 * the outbound handlers' params and the run the job object posts; the reads
 * then go through the class's own registered handler. Runs on Node: no R2
 * and no `DigestStream` are on the path (the bucket answers a read as R2's
 * binding does, for the one call the handler makes).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniToolJobRequest } from "@breatic/shared";

const stand = vi.hoisted(() => {
  /** What the stand-in base recorded for the newest instance. */
  const recorded = {
    outbound: {} as Record<string, unknown>,
    posted: [] as { url: string; body: Record<string, unknown> }[],
  };

  /** Stand-in for `@cloudflare/containers`' `Container`. */
  class Container {
    ctx: unknown;
    env: unknown;

    /**
     * Keep the object state and bindings.
     * @param ctx - The object state.
     * @param env - The bindings.
     */
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    /**
     * Record the outbound handlers by host.
     * @param hosts - The handlers.
     * @returns Nothing.
     */
    async setOutboundByHosts(hosts: Record<string, unknown>): Promise<void> {
      recorded.outbound = hosts;
    }

    /**
     * Start nothing.
     * @returns Nothing.
     */
    async start(): Promise<void> {}

    /**
     * Record the run the object posts and accept it.
     * @param request - The run.
     * @returns 202.
     */
    async containerFetch(request: Request): Promise<Response> {
      recorded.posted.push({ url: request.url, body: await request.json() });
      return new Response(null, { status: 202 });
    }

    /**
     * Schedule nothing.
     * @returns A schedule record.
     */
    async schedule(): Promise<{ id: string }> {
      return { id: "schedule-1" };
    }

    /** Delete no schedule. */
    deleteSchedules(): void {}

    /**
     * Destroy nothing.
     * @returns Nothing.
     */
    async destroy(): Promise<void> {}
  }

  return { recorded, Container };
});

vi.mock("@cloudflare/containers", () => ({ Container: stand.Container }));

const { MiniToolContainerStd4 } = await import("@ingest/jobs/mini-tool-container.js");
const { MEDIA_OBJECT_HOST, mediaObjectUrl } = await import("@ingest/media-object-route.js");

/** The outbound handler signature the class registers. */
type Handler = (request: Request, env: unknown, ctx: { params: unknown; className: string; containerId: string }) => Promise<Response>;

const SOURCE = "video/2026-11-10/a.mp4";
const CLIP_B = "video/2026-11-10/b.mp4";
const CLIP_C = "video/2026-11-10/c.mp4";
const OTHER = "video/2026-11-10/someone-else.mp4";

/**
 * A bucket holding a few bytes under every key, answering a read as R2 does.
 * @returns The bucket.
 */
function bucket(): R2Bucket {
  return {
    get: async () => ({ body: new Blob(["bytes"]).stream(), size: 5, range: undefined }),
  } as unknown as R2Bucket;
}

/**
 * Submit a job to a fresh object.
 * @param extra - The further inputs the job names, if any.
 * @returns The recorded run and the read handler's params.
 */
async function submitted(extra?: { storageKey: string }[]): Promise<{ body: Record<string, unknown>; params: unknown }> {
  const storage = new Map<string, unknown>();
  const ctx = {
    id: { toString: (): string => "job-object-1" },
    container: { running: true },
    storage: {
      get: async (key: string): Promise<unknown> => storage.get(key),
      put: async (key: string, value: unknown): Promise<void> => {
        storage.set(key, structuredClone(value));
      },
      delete: async (key: string): Promise<boolean> => storage.delete(key),
    },
  };
  const job = new MiniToolContainerStd4(ctx as never, { BUCKET: bucket() } as never);
  const request = {
    jobId: "task:t1",
    containerClass: "MiniToolContainerStd4",
    deadlineAt: Date.now() + 3_600_000,
    op: "join",
    params: { crossfade: 0 },
    input: { storageKey: SOURCE },
    ...(extra !== undefined && { extra }),
    outputs: [{ storageKey: "video/2026-11-10/out.mp4", contentType: "video/mp4" }],
  } as unknown as MiniToolJobRequest;
  await job.submit(request);
  const posted = stand.recorded.posted.at(-1);
  if (posted === undefined) throw new Error("the job object posted no run");
  const host = stand.recorded.outbound[MEDIA_OBJECT_HOST] as { params: unknown } | undefined;
  if (host === undefined) throw new Error(`no handler for ${MEDIA_OBJECT_HOST}`);
  return { body: posted.body, params: host.params };
}

/**
 * Read one key through the class's registered handler.
 * @param params - What the job object gave the handler.
 * @param key - The key the container asks for.
 * @returns The answer's status.
 */
async function read(params: unknown, key: string): Promise<number> {
  const handlers = (MiniToolContainerStd4 as unknown as { outboundHandlers: Record<string, Handler> }).outboundHandlers;
  const handler = handlers.jobObjects!;
  const answered = await handler(new Request(mediaObjectUrl(key)), { BUCKET: bucket() }, {
    params,
    className: "MiniToolContainerStd4",
    containerId: "job-object-1",
  });
  return answered.status;
}

beforeEach(() => {
  stand.recorded.outbound = {};
  stand.recorded.posted.length = 0;
});

describe("a job with further inputs", () => {
  it("hands the container every further input's address, in order, beside the source's", async () => {
    const { body } = await submitted([{ storageKey: CLIP_B }, { storageKey: CLIP_C }]);

    expect(body.input).toBe(mediaObjectUrl(SOURCE));
    expect(body.extra).toEqual([mediaObjectUrl(CLIP_B), mediaObjectUrl(CLIP_C)]);
  });

  it("lets the container read the source and every further input", async () => {
    const { params } = await submitted([{ storageKey: CLIP_B }, { storageKey: CLIP_C }]);

    for (const key of [SOURCE, CLIP_B, CLIP_C]) expect(await read(params, key), key).toBe(200);
  });

  it("still refuses every key the job does not name", async () => {
    const { params } = await submitted([{ storageKey: CLIP_B }]);

    expect(await read(params, OTHER)).toBe(403);
    expect(await read(params, CLIP_C)).toBe(403);
  });
});

describe("a job with one input", () => {
  // A job queued before joins existed names no further input, and runs as it always did.
  it("hands the container no further address and reads only its source", async () => {
    const { body, params } = await submitted();

    expect(body.extra ?? []).toEqual([]);
    expect(await read(params, SOURCE)).toBe(200);
    expect(await read(params, CLIP_B)).toBe(403);
  });
});
