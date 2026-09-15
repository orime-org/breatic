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
import type { ProbeReport } from "@ingest/media-metadata.js";
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
 * @param cover - The frame it cut, or null for none.
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
        run.asked = await request.json<ProbeRequest>();
        return buildProbeAnswer(report, cover);
      },
    }),
  } as unknown as Env["MEDIA"];
  return run;
}
