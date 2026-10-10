// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Durable Object that hosts the upright arbiter for tests.
 *
 * The production host is `MediaContainer`, which refuses to construct without
 * a container image. This one hands the arbiter the same real storage, the same
 * real bucket and the same exclusive sections, and stands a scripted run in for
 * the container: the script stages a write-back the way the outbound handler
 * does and hands it to the arbiter's commit.
 */

import { DurableObject } from "cloudflare:workers";
import { MEDIA_DIMENSIONS_STUB, PREVIEW_STUB, UPRIGHT_BYTES } from "./arbiter-fixtures.js";
import {
  RECEIVED_SHA256,
  UprightArbiter,
  type ArbiterAnswer,
  type ArbiterAsk,
  type UprightRunAnswer,
  type UprightRunRequest,
} from "@ingest/upright-arbiter.js";

/** The bindings the host needs. */
export interface HostEnv {
  BUCKET: R2Bucket;
  ARBITER_HOST: DurableObjectNamespace<ArbiterHost>;
}

/** How the stand-in run behaves. */
export type RunScript = "commits" | "fails" | "noInstanceTwiceThenCommits" | "holdsUntilReleased";

/** The arbiter under a real Durable Object. */
export class ArbiterHost extends DurableObject<HostEnv> {
  readonly #arbiter: UprightArbiter;

  #script: RunScript = "commits";

  #runs = 0;

  #release: (() => void) | null = null;

  readonly #logged: string[] = [];

  /**
   * The host and its arbiter.
   * @param ctx - The object's state.
   * @param env - Its bindings.
   */
  constructor(ctx: DurableObjectState, env: HostEnv) {
    super(ctx, env);
    this.#arbiter = new UprightArbiter({
      storage: ctx.storage,
      bucket: env.BUCKET,
      exclusive: (fn) => ctx.blockConcurrencyWhile(fn),
      runContainer: (request) => this.#runOnce(request),
      log: (label) => this.#logged.push(label),
      now: () => Date.now(),
    });
  }

  /**
   * Choose how the next runs behave.
   * @param script - The behaviour.
   * @returns Nothing.
   */
  setScript(script: RunScript): void {
    this.#script = script;
  }

  /**
   * Let a held run go on.
   * @returns Nothing.
   */
  release(): void {
    this.#release?.();
  }

  /**
   * Ask the arbiter.
   * @param ask - What a finish asks.
   * @returns Its answer.
   */
  ask(ask: ArbiterAsk): Promise<ArbiterAnswer> {
    return this.#arbiter.ask(ask);
  }

  /**
   * What the write-back handler calls.
   * @param commit - The staged write-back.
   * @param commit.storageKey - The key it writes to.
   * @param commit.uploadId - R2's id for the multipart upload.
   * @param commit.parts - The parts that landed.
   * @returns Whether it now stands.
   */
  commitUpright(commit: { storageKey: string; uploadId: string; parts: R2UploadedPart[] }): Promise<boolean> {
    return this.#arbiter.commit(commit);
  }

  /**
   * How many container runs were started, and what was logged.
   * @returns The counts.
   */
  seen(): { runs: number; logged: string[] } {
    return { runs: this.#runs, logged: [...this.#logged] };
  }

  /**
   * Stage a write-back of the upright bytes and hand it to the arbiter.
   * @param request - What the run was asked.
   * @returns Whether the arbiter completed it.
   */
  async stageAndCommit(request: Pick<UprightRunRequest, "storageKey" | "receivedSha256" | "httpMetadata">): Promise<boolean> {
    const upload = await this.env.BUCKET.createMultipartUpload(request.storageKey, {
      httpMetadata: request.httpMetadata,
      customMetadata: { [RECEIVED_SHA256]: request.receivedSha256 },
    });
    const part = await upload.uploadPart(1, UPRIGHT_BYTES);
    return this.#arbiter.commit({ storageKey: request.storageKey, uploadId: upload.uploadId, parts: [part] });
  }

  /**
   * Stage a write-back, complete it outside the arbiter, then hand the same
   * upload to the arbiter, whose own complete then fails with the object
   * already standing.
   * @param request - What the run was asked.
   * @returns Whether the arbiter judged it landed.
   */
  async commitAlreadyCompleted(request: Pick<UprightRunRequest, "storageKey" | "receivedSha256" | "httpMetadata">): Promise<boolean> {
    const upload = await this.env.BUCKET.createMultipartUpload(request.storageKey, {
      httpMetadata: request.httpMetadata,
      customMetadata: { [RECEIVED_SHA256]: request.receivedSha256 },
    });
    const part = await upload.uploadPart(1, UPRIGHT_BYTES);
    await upload.complete([part]);
    return this.#arbiter.commit({ storageKey: request.storageKey, uploadId: upload.uploadId, parts: [part] });
  }

  /**
   * One stand-in container run.
   * @param request - What the arbiter asked.
   * @returns How it ended.
   */
  async #runOnce(request: UprightRunRequest): Promise<UprightRunAnswer> {
    this.#runs += 1;
    if (this.#script === "fails") return { kind: "failed" };
    if (this.#script === "noInstanceTwiceThenCommits" && this.#runs <= 2) return { kind: "noInstance" };
    if (this.#script === "holdsUntilReleased") {
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    const committed = await this.stageAndCommit(request);
    return committed
      ? { kind: "measured", media: MEDIA_DIMENSIONS_STUB, preview: PREVIEW_STUB }
      : { kind: "failed" };
  }
}

export default {
  /**
   * Nothing is served; the tests reach the object through its binding.
   * @returns 404.
   */
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
