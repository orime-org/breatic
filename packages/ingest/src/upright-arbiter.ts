// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One key's upright arbiter (inner#1367 design §4.4).
 *
 * Every finish of a key that reads an orientation of 2-8 asks here, and so does
 * one whose orientation read failed. The arbiter starts at most one run per
 * key, completes at most one write-back, and once the key is abandoned aborts
 * every write-back that still arrives, so no finish answers for bytes that
 * change after it answered. Its state goes through `uprightTransition` only.
 *
 * It holds nothing of the platform itself: the Durable Object hosting it hands
 * in its storage, the bucket, a way to run the container and a way to run code
 * exclusively, so the same code is exercised against real storage and a real
 * bucket in tests.
 */

import { previewKeyFor } from "@breatic/shared";
import type { MediaMetadata } from "@ingest/media-metadata.js";
import type { RecordedPart } from "@ingest/stored-object.js";
import {
  uprightTransition,
  type UprightEvent,
  type UprightState,
} from "@ingest/upright-transition.js";

/** Where the state sits in the hosting object's storage. */
const STATE_KEY = "upright";

/** The metadata key a written-back object carries its received hash under. */
export const RECEIVED_SHA256 = "received-sha256";

/** How long to wait before asking again for an instance. */
const NO_INSTANCE_RETRY_MS = 300;

/** The type the stored previews are written as. */
const PREVIEW_TYPE = "image/webp";

/** What one finish asks of the arbiter. */
export interface ArbiterAsk {
  /** `request` to have the key turned upright; `seal` when its orientation could not be read. */
  kind: "request" | "seal";
  storageKey: string;
  /** The hash of the bytes as received, carried on the written-back object. */
  receivedSha256: string;
  /** Whether a WebP's image data is lossless. */
  lossless: boolean;
  /** Epoch ms after which this finish stops waiting. */
  waitBy: number;
}

/** What the arbiter tells a finish. */
export interface ArbiterAnswer {
  /** `done`: the object was turned upright. `abandoned`: it was left as received. */
  phase: "done" | "abandoned";
  /** What the run measured on the written object, when it got that far. */
  media: MediaMetadata | null;
}

/** What one container run is asked to do. */
export interface UprightRunRequest {
  storageKey: string;
  receivedSha256: string;
  lossless: boolean;
  /** The original object's HTTP metadata, written back unchanged. */
  httpMetadata: R2HTTPMetadata;
  /** Epoch ms by which the run has to have answered. */
  deadlineAt: number;
}

/** How one container run ended. */
export type UprightRunAnswer =
  | { kind: "measured"; media: MediaMetadata; preview: Uint8Array | null }
  | { kind: "failed" }
  | { kind: "noInstance" };

/** What the hosting object hands the arbiter. */
export interface ArbiterDeps {
  storage: Pick<DurableObjectStorage, "get" | "put">;
  bucket: R2Bucket;
  /** Runs `fn` with no other exclusive section interleaved. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Runs the container once; never throws for a run that failed. */
  runContainer: (request: UprightRunRequest) => Promise<UprightRunAnswer>;
  /** Writes a failure down. */
  log: (label: string, ctx: Record<string, unknown>, err?: unknown) => void;
  /** Epoch ms now. */
  now: () => number;
}

/** One key's arbiter. */
export class UprightArbiter {
  readonly #deps: ArbiterDeps;

  readonly #listeners = new Set<() => void>();

  /**
   * An arbiter over the hosting object's storage.
   * @param deps - What the hosting object hands in.
   */
  constructor(deps: ArbiterDeps) {
    this.#deps = deps;
  }

  /**
   * Ask for the key to be turned upright, or seal it, and wait for the outcome.
   * @param ask - What this finish asks.
   * @returns Whether the object was turned upright, with what the run measured.
   */
  async ask(ask: ArbiterAsk): Promise<ArbiterAnswer> {
    const starts = await this.#deps.exclusive(() => this.#apply({ type: ask.kind }, ask.storageKey));
    if (starts.includes("startRun")) void this.#run(ask);
    return this.#await(ask);
  }

  /**
   * Complete or abort a write-back the container's outbound handler staged.
   *
   * The completion runs in the same exclusive section as the state change, so
   * a give-up either lands before it, and the write-back is aborted, or after
   * it, and the key is already done.
   * @param commit - The staged write-back.
   * @param commit.storageKey - The key it writes to.
   * @param commit.uploadId - R2's id for the multipart upload the handler opened.
   * @param commit.parts - The parts that landed.
   * @returns True when the write-back now stands at the key.
   */
  commit(commit: { storageKey: string; uploadId: string; parts: RecordedPart[] }): Promise<boolean> {
    return this.#deps.exclusive(async () => {
      const effects = await this.#apply({ type: "commitAsked" }, commit.storageKey);
      const upload = this.#deps.bucket.resumeMultipartUpload(commit.storageKey, commit.uploadId);
      if (!effects.includes("complete")) {
        await upload.abort().catch((err: unknown) => {
          this.#deps.log("ingest_upright_abort_failed", { storageKey: commit.storageKey }, err);
        });
        return false;
      }
      const landed = await this.#complete(upload, commit);
      await this.#apply({ type: "commitSettled", landed }, commit.storageKey);
      return landed;
    });
  }

  /**
   * Complete the upload, judging an error by whether the object now carries the mark.
   * @param upload - The staged upload.
   * @param commit - What it writes.
   * @param commit.storageKey - The key it writes to.
   * @param commit.parts - The parts that landed.
   * @returns True when the write-back stands.
   */
  async #complete(
    upload: R2MultipartUpload,
    commit: { storageKey: string; parts: RecordedPart[] },
  ): Promise<boolean> {
    const ordered = [...commit.parts].sort((a, b) => a.partNumber - b.partNumber);
    try {
      await upload.complete(ordered);
      return true;
    } catch (err) {
      const stored = await this.#deps.bucket.head(commit.storageKey).catch(() => null);
      const landed = stored?.customMetadata?.[RECEIVED_SHA256] !== undefined;
      if (!landed) {
        this.#deps.log("ingest_upright_complete_failed", { storageKey: commit.storageKey }, err);
        await upload.abort().catch(() => undefined);
      }
      return landed;
    }
  }

  /**
   * Run the container until it answers or the asking finish's time is up.
   * @param ask - The request that started the run.
   * @returns Nothing; the outcome lands in the state.
   */
  async #run(ask: ArbiterAsk): Promise<void> {
    const { storageKey } = ask;
    try {
      const original = await this.#deps.bucket.head(storageKey);
      if (original === null) throw new Error("No object to turn upright");
      let answer: UprightRunAnswer = { kind: "noInstance" };
      while (answer.kind === "noInstance" && this.#deps.now() < ask.waitBy) {
        answer = await this.#deps.runContainer({
          storageKey,
          receivedSha256: ask.receivedSha256,
          lossless: ask.lossless,
          httpMetadata: original.httpMetadata ?? {},
          deadlineAt: ask.waitBy,
        });
        if (answer.kind === "noInstance") await sleep(NO_INSTANCE_RETRY_MS);
      }
      if (answer.kind === "measured") {
        await this.#storePreview(storageKey, answer.preview);
        await this.#deps.exclusive(() => this.#apply({ type: "runEnded", media: answer.media }, storageKey));
        return;
      }
    } catch (err) {
      this.#deps.log("ingest_upright_run_failed", { storageKey }, err);
    }
    await this.#deps.exclusive(() => this.#apply({ type: "runEnded", media: null }, storageKey));
  }

  /**
   * Store the preview a run cut, when the key was turned upright.
   * @param storageKey - The key it was cut from.
   * @param preview - The WebP, or null when none was cut.
   * @returns Nothing; a preview that could not be stored is written down.
   */
  async #storePreview(storageKey: string, preview: Uint8Array | null): Promise<void> {
    if (preview === null) return;
    const state = await this.#deps.storage.get<UprightState>(STATE_KEY);
    if (state?.phase !== "done") return;
    const previewKey = previewKeyFor(storageKey);
    await this.#deps.bucket
      .put(previewKey, preview, { httpMetadata: { contentType: PREVIEW_TYPE } })
      .catch((err: unknown) => this.#deps.log("ingest_preview_store_failed", { previewKey }, err));
  }

  /**
   * Wait until the key's outcome is settled or this finish's time is up.
   * @param ask - The finish waiting.
   * @returns The outcome as it stands.
   */
  async #await(ask: ArbiterAsk): Promise<ArbiterAnswer> {
    for (;;) {
      const state = await this.#deps.storage.get<UprightState>(STATE_KEY);
      if (settled(state)) return answerOf(state);
      const left = ask.waitBy - this.#deps.now();
      if (left <= 0) {
        await this.#deps.exclusive(() => this.#apply({ type: "giveUp" }, ask.storageKey));
        return answerOf(await this.#deps.storage.get<UprightState>(STATE_KEY));
      }
      await this.#woken(left);
    }
  }

  /**
   * Resolve on the next state change, or after `ms`.
   * @param ms - The most to wait.
   * @returns Nothing.
   */
  #woken(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const listener = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve();
      };
      const timer = setTimeout(listener, ms);
      this.#listeners.add(listener);
    });
  }

  /**
   * Apply one event to the stored state; call inside an exclusive section.
   * @param event - What happened.
   * @param storageKey - The key, for the log.
   * @returns The effects the transition asked for.
   */
  async #apply(event: UprightEvent, storageKey: string): Promise<string[]> {
    const state = (await this.#deps.storage.get<UprightState>(STATE_KEY)) ?? null;
    const next = uprightTransition(state, event);
    if (next.state !== state && next.state !== null) await this.#deps.storage.put(STATE_KEY, next.state);
    if (next.effects.includes("logFailure")) {
      this.#deps.log("ingest_upright_failed", { storageKey, event: event.type });
    }
    if (next.effects.includes("wake")) {
      const listeners = [...this.#listeners];
      this.#listeners.clear();
      for (const listener of listeners) listener();
    }
    return next.effects;
  }
}

/**
 * Whether a key's outcome is known for good.
 * @param state - The stored state.
 * @returns True when abandoned, or done with its run ended.
 */
function settled(state: UprightState | undefined): boolean {
  if (state === undefined) return true;
  return state.phase === "abandoned" || (state.phase === "done" && state.runEnded);
}

/**
 * What a finish is told.
 * @param state - The stored state.
 * @returns The phase and the measured numbers.
 */
function answerOf(state: UprightState | undefined): ArbiterAnswer {
  if (state?.phase === "done") return { phase: "done", media: state.media };
  return { phase: "abandoned", media: null };
}

/**
 * Wait `ms`.
 * @param ms - Milliseconds.
 * @returns Nothing.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
