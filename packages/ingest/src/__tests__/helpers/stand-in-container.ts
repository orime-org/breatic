// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A container namespace that answers without a container.
 *
 * The binding the suites declare has no image behind it, so a real run never
 * starts and the request this side sends is never seen. Both lanes that reach
 * `finishUpload` have to get that request right, so both stand the container
 * in the same way.
 */

import { buildProbeAnswer, type ProbeRequest } from "@ingest/probe-answer.js";
import { pickMediaMetadata, type ProbeReport } from "@ingest/media-metadata.js";
import type { Env } from "@ingest/index.js";

/** What a stand-in container was asked, and the namespace to pass in. */
export interface StandInRun {
  media: Env["MEDIA"];
  /** The key its outbound handler was authorised for. */
  authorisedFor: string | null;
  /** The body it received, once it has received one. */
  asked: ProbeRequest | null;
}

/**
 * Stand a container in for one run.
 * @param report - What it answers with.
 * @param cover - The frame there is to cut, or null when there is none. Handed
 *   back only where a real run would hand it back, so a suite cannot pin
 *   behaviour on an answer the container never gives.
 * @returns The namespace and what it was asked.
 */
export function containerAnswering(
  report: ProbeReport,
  cover: Uint8Array | null,
): StandInRun {
  const run: StandInRun = {
    media: null as unknown as Env["MEDIA"],
    authorisedFor: null,
    asked: null,
  };
  run.media = {
    idFromName: (name: string) => name,
    get: () => ({
      setOutboundByHost: (
        _host: string,
        _handler: string,
        params: { key: string },
      ): Promise<void> => {
        run.authorisedFor = params.key;
        return Promise.resolve();
      },
      fetch: async (request: Request): Promise<Response> => {
        const asked = await request.json<ProbeRequest>();
        run.asked = asked;
        // The gate a real run puts in front of its cover call: it lifts a frame
        // only when one was asked for and the report holds one that is not
        // attached album art. Answering past that would let a suite pin
        // behaviour on bytes no container ever hands back.
        const lifts =
          asked.wantCover && pickMediaMetadata(report).width !== null;
        return buildProbeAnswer(report, lifts ? cover : null);
      },
    }),
  } as unknown as Env["MEDIA"];
  return run;
}
