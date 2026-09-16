// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The edge side of reading an object's media numbers (#209 + #210, design §3.3).
 *
 * What the container runs is ffmpeg; what this side does is start one, wait
 * under a deadline, and read the answer. Those are separate runtimes and
 * separate failures, so they are separate modules: the container extends a
 * base class that reaches for `cloudflare:workers` when it is loaded, and
 * nothing here does. This file is therefore readable outside workerd, which is
 * what lets the deadline be measured against a clock rather than against how
 * soon an isolate happens to be scheduled.
 *
 * The vocabulary both sides speak — what has to be bound, what the outbound
 * handler is called, and what it is told — is declared here, and the container
 * reads it from here. One direction only: a value this file took from the
 * container would pull that base class back in.
 */

import { mediaObjectUrl, MEDIA_OBJECT_HOST } from "@ingest/media-object-route.js";
import {
  PROBE_PATH,
  readProbeAnswer,
  type ProbeAnswer,
  type ProbeRequest,
} from "@ingest/probe-answer.js";
import { NOTHING_FOUND } from "@ingest/media-metadata.js";
import type { MediaContainer } from "@ingest/media-container.js";
import type { MediaLimits } from "@breatic/shared";

/** What reading media off a stored object needs bound. */
export interface MediaEnv {
  BUCKET: R2Bucket;
  MEDIA: DurableObjectNamespace<MediaContainer>;
}

/** Which key one instance may read, handed to its outbound handler. */
export interface ServeOneKey {
  key: string;
}

/** The name the instance refers to that handler by. */
export const SERVE_OBJECT = "serveObject";

/**
 * The media types worth handing to ffmpeg.
 *
 * Everything else — a text file, a PDF, an archive — has none of the three
 * numbers, and starting a container to be told so costs a second per upload.
 */
const PROBEABLE = /^(?:image|video|audio)\//;

/** What one read answered, or nothing when it could not be run. */
const NOTHING_READ: ProbeAnswer = Object.freeze({
  report: NOTHING_FOUND,
  cover: null,
});

/** What the deadline resolves with, telling it apart from what a run answers. */
const UNFINISHED = Symbol("unfinished");

/**
 * Read one stored object's media numbers, and cut a cover when one is wanted.
 *
 * Answers as nothing found for anything that goes wrong — an unreachable
 * container, a run past the deadline, an unreadable answer. None of it decides
 * whether the upload succeeded: what it decides is whether a node shows a
 * resolution and a poster, and a video without one shows the film icon.
 * @param env - The Worker's bindings.
 * @param about - The object to read.
 * @param about.storageKey - Its key, which is also the only key this run may
 *   read.
 * @param about.contentType - What the stored bytes read as, which says whether
 *   ffmpeg has anything to say about it.
 * @param about.wantCover - Whether to ask for a frame as well.
 * @param about.limits - How long this run gets, and how long one tool inside
 *   it may take. Both come off `config/storage.yaml` by way of the caller; the
 *   Worker reads no configuration of its own.
 * @returns What the container answered, or nothing found.
 */
export async function readMediaAtEdge(
  env: MediaEnv,
  about: {
    storageKey: string;
    contentType: string;
    wantCover: boolean;
    limits: MediaLimits;
  },
): Promise<ProbeAnswer> {
  if (!PROBEABLE.test(about.contentType)) return NOTHING_READ;

  const instance = env.MEDIA.get(env.MEDIA.idFromName(about.storageKey));
  const asked: ProbeRequest = {
    objectUrl: mediaObjectUrl(about.storageKey),
    wantCover: about.wantCover,
    toolTimeoutMs: about.limits.toolTimeoutMs,
  };

  const answered = await Promise.race([
    (async (): Promise<Response> => {
      // What arrives as `ctx.params` in the container's handler. The stub is
      // reached over RPC, whose types carry no generic through, so the link
      // between what is sent and what is read is stated here.
      const authorised: ServeOneKey = { key: about.storageKey };
      await instance.setOutboundByHost(
        MEDIA_OBJECT_HOST,
        SERVE_OBJECT,
        authorised,
      );
      return instance.fetch(
        new Request(`http://media${PROBE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(asked),
        }),
      );
    })(),
    // Stops the waiting, not the run. Nothing can reach into a container to
    // end one, and what is left behind sleeps on its own.
    new Promise<typeof UNFINISHED>((resolve) => {
      setTimeout(() => resolve(UNFINISHED), about.limits.runDeadlineMs);
    }),
  ]).catch((err: unknown) => {
    console.error("ingest_media_read_failed", {
      storageKey: about.storageKey,
      err: err instanceof Error ? err.stack : String(err),
    });
    return null;
  });

  if (answered === UNFINISHED) {
    // Written down because from the caller's side a run still going is
    // indistinguishable from one that threw — and a cold start on the long
    // tail is the commonest way this step fails. The timer that resolved this
    // is the only thing that could say so, and it says it here rather than
    // where it fires, so a run that answered first never reaches this line.
    console.error("ingest_media_read_unfinished", {
      storageKey: about.storageKey,
      runDeadlineMs: about.limits.runDeadlineMs,
    });
    return NOTHING_READ;
  }
  if (answered === null) return NOTHING_READ;
  if (!answered.ok) {
    console.error("ingest_media_read_refused", {
      storageKey: about.storageKey,
      status: answered.status,
    });
    return NOTHING_READ;
  }
  return readProbeAnswer(answered);
}
