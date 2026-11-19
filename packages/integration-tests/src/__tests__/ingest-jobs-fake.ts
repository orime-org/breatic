// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ingest `/jobs` boundary faked at `fetch` for runs whose model input is
 * prepared on standard-4 before `generate` (inner#1306 test plan §90 E3b).
 * Every submitted container job is recorded and, unless a case scripts its
 * report, answered done at once with its declared output and measured usage.
 */

import { readFileSync } from "node:fs";
import { vi } from "vitest";

const SOURCE_LEDGER = readFileSync(new URL("../../../worker/src/handlers/__tests__/fixtures/presentation/cfr96-source-a.ledger.json", import.meta.url));

/** The recorded submissions and any scripted reports by job id. */
export interface IngestJobsFake { submitted: Record<string, unknown>[]; scripted: Map<string, Record<string, unknown>> }

/**
 * A finished report echoing a request's declared output.
 * @param request - The submitted job request.
 * @returns The done report.
 */
function done(request: Record<string, unknown>): Record<string, unknown> {
  const output = (request.outputs as { outputIndex: number; storageKey: string; contentType: string }[])[0]!;
  return { schemaVersion: 2, state: "done", outputs: [{ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }],
    usage: { wallMs: 1000, cpuUsec: 2000000 } };
}

/**
 * Stub `fetch` with the `/jobs` boundary; call in `beforeEach` and `vi.unstubAllGlobals()` after the suite.
 * @returns The fake's recorded state.
 */
export function fakeIngestJobs(): IngestJobsFake {
  const jobs: IngestJobsFake = { submitted: [], scripted: new Map() };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/jobs" && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>; jobs.submitted.push(request);
      return Response.json(jobs.scripted.get(String(request.jobId)) ?? done(request));
    }
    if (url.pathname.startsWith("/jobs/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const request = jobs.submitted.find((candidate) => candidate.jobId === id);
      return request === undefined ? new Response("missing", { status: 404 }) : Response.json(jobs.scripted.get(id) ?? done(request));
    }
    // S6d D3b (inner#1306 §91): the one full ledger the frozen removal plans name (execution-lifecycle-fixtures.ts receipt).
    if (url.pathname.includes(".video-source-ledger.")) return new Response(SOURCE_LEDGER, { headers: { "content-type": "application/json" } });
    return new Response("unexpected", { status: 500 });
  }));
  return jobs;
}

/** The environment the ingest boundary is addressed with in these fixtures. */
export const INGEST_ENV = { INGEST_BASE_URL: "https://ingest.example.test", INGEST_SHARED_SECRET: "fixture-ingest-secret" };
