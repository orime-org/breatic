// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AgentPictureSpec } from "@breatic/shared";

/** An actual attachment or tool-returned picture source, in occurrence order. */
export interface AgentPictureSource {
  label: string;
  sourceUrl: string;
}

/** The registered source row, resolved under this turn's Studio authorization. */
export interface AgentPictureSourceAsset {
  storageKey: string;
  contentType: string;
}

/** Facts returned only after ingest has confirmed the derived JPEG exists. */
export interface AgentPictureFacts {
  url: string;
  sizeBytes: number;
  mediaType: "image/jpeg";
}

/** A source or transform failure that can be explained to the user. */
export interface AgentPictureUnavailable {
  status: "unavailable";
  reason: string;
}

/** Each occurrence retains its own label even when preparation was shared. */
export type PreparedAgentPicture = AgentPictureSource & (
  | ({ status: "ready" } & AgentPictureFacts)
  | AgentPictureUnavailable
);

/** One turn's bounded, memoized picture preparation callback. */
export type PrepareAgentPictures = (
  sources: readonly AgentPictureSource[],
  signal?: AbortSignal,
) => Promise<PreparedAgentPicture[]>;

/** Optional picture capabilities bound to a tool at factory time. */
export interface ToolPictureContext {
  seesPictures?: boolean;
  preparePictures?: PrepareAgentPictures;
}

/** Dependencies supplied by the caller that owns auth, storage and logging. */
export interface AgentPicturePreparation {
  spec: AgentPictureSpec;
  concurrency: number;
  resolveSource: (source: AgentPictureSource, signal?: AbortSignal) => Promise<AgentPictureSourceAsset | AgentPictureUnavailable>;
  readPicture: (
    asset: AgentPictureSourceAsset,
    spec: AgentPictureSpec,
    signal?: AbortSignal,
  ) => Promise<AgentPictureFacts | AgentPictureUnavailable>;
}

/** The memo stores source facts, never the first occurrence's label. */
type PreparedFacts = ({ status: "ready" } & AgentPictureFacts) | AgentPictureUnavailable;

/**
 * Stop waiting on a dependency even when it cannot cancel its already started work.
 * @param pending - Source authorization or edge preparation already in flight.
 * @param signal - This turn's stop signal.
 * @returns The result only while this turn remains active.
 * @throws {unknown} The dependency failure or the turn's stop reason.
 */
async function waitForPicture<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    /**
     * End this wait without accepting the dependency's later result.
     * @throws {never} Never.
     */
    const stop = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
    void pending.then(resolve, reject).finally(() => { signal.removeEventListener("abort", stop); });
    if (signal.aborted) stop();
  });
}

/**
 * Create one preparation table and concurrency gate for one agent turn.
 * @param dependencies - The fixed spec, bound source resolver and ingest reader.
 * @returns A callback sharing all pending and completed work for this turn.
 * @throws {never} Creating the table performs no IO.
 */
export function createAgentPicturePreparer(dependencies: AgentPicturePreparation): PrepareAgentPictures {
  const { concurrency, resolveSource, readPicture } = dependencies;
  const spec = { ...dependencies.spec };
  const memo = new Map<string, Promise<PreparedFacts>>();
  const queued: Array<() => void> = [];
  let active = 0;

  /**
   * Run a unique source only when the turn's preparation slot is available.
   * @param source - The source's first occurrence.
   * @param signal - The turn's stop signal.
   * @returns Its JPEG facts or a typed unavailable result.
   * @throws {unknown} Infrastructure failures and the turn's stop reason.
   */
  async function prepareSource(source: AgentPictureSource, signal?: AbortSignal): Promise<PreparedFacts> {
    signal?.throwIfAborted();
    const asset = await waitForPicture(resolveSource(source, signal), signal);
    signal?.throwIfAborted();
    if ("status" in asset) return asset;
    const picture = await waitForPicture(readPicture(asset, spec, signal), signal);
    signal?.throwIfAborted();
    if ("status" in picture) return picture;
    if (!Number.isSafeInteger(picture.sizeBytes) || picture.sizeBytes <= 0 || picture.mediaType !== "image/jpeg") {
      return { status: "unavailable", reason: "incomplete-picture-facts" };
    }
    return { status: "ready", ...picture };
  }

  /**
   * Start queued sources while a slot is available across all concurrent batches.
   * @throws {never} Each queued callback forwards failures to its own Promise.
   */
  function drain(): void {
    while (active < concurrency && queued.length > 0) queued.shift()?.();
  }

  /**
   * Queue unique source work behind the turn's single preparation gate.
   * @param source - The source occurrence that owns the shared work.
   * @param signal - The turn's stop signal.
   * @returns The source's eventual facts.
   * @throws {unknown} Infrastructure failures and the turn's stop reason.
   */
  function queueSource(source: AgentPictureSource, signal?: AbortSignal): Promise<PreparedFacts> {
    return new Promise<PreparedFacts>((resolve, reject) => {
      queued.push(() => {
        active += 1;
        void prepareSource(source, signal).then(resolve, reject).finally(() => {
          active -= 1;
          drain();
        });
      });
      drain();
    });
  }

  /**
   * Resolve one batch without changing occurrence order or repeating source IO.
   * @param sources - Occurrences supplied by the user message or tool result.
   * @param signal - The turn's stop signal.
   * @returns One result for each supplied occurrence.
   * @throws {unknown} Infrastructure failures and the turn's stop reason.
   */
  return async function prepareAgentPictures(
    sources: readonly AgentPictureSource[],
    signal?: AbortSignal,
  ): Promise<PreparedAgentPicture[]> {
    signal?.throwIfAborted();
    return Promise.all(sources.map(async (source): Promise<PreparedAgentPicture> => {
      signal?.throwIfAborted();
      const key = JSON.stringify([source.sourceUrl, spec]);
      let pending = memo.get(key);
      if (pending === undefined) {
        pending = queueSource(source, signal);
        memo.set(key, pending);
      }
      const result = await waitForPicture(pending, signal);
      signal?.throwIfAborted();
      return { ...source, ...result };
    }));
  };
}
