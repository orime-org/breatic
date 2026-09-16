// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The deadline a container run is waited under (#209 + #210, design §3.3).
 *
 * Waiting is bounded because a finish request is what waits, and a cold start
 * on the long tail is the commonest way this step fails. Giving up says so in
 * the log, and the log is the only trace the run ever existed — so it has to
 * be written when the deadline actually decided the outcome, and not when a
 * run answered first.
 *
 * Runs on Node, which is what the `.node.test.ts` in the name says. What is
 * asserted here is a race between a stub that never answers and a timer, and
 * both are read off the same clock the assertion is written against. Under the
 * Workers pool this file was measured at 95ms, 5850ms and 35788ms on three
 * green CI runs of main, because what it spent was however long an isolate
 * took to be scheduled; a budget written against a 20ms timer cannot be sized
 * against that.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readMediaAtEdge, type MediaEnv } from "@ingest/media-read.js";
import { buildProbeAnswer } from "@ingest/probe-answer.js";
import { NOTHING_FOUND, type ProbeReport } from "@ingest/media-metadata.js";

const KEY = "video/2026-09-11/1_deadline.mp4";

/** A 640x360 film, the shape ffprobe answers with. */
const FILM: ProbeReport = {
  durationSeconds: 3,
  streams: [
    {
      index: 0,
      codecType: "video",
      codecName: "h264",
      width: 640,
      height: 360,
      attachedPic: false,
    },
  ],
};

/**
 * Bindings whose container answers the way `answer` says.
 * @param answer - What the instance's fetch does.
 * @returns The bindings to read under.
 */
function containerThat(answer: () => Promise<Response>): MediaEnv {
  return {
    // Bound because the type says so. Reading media never reaches the bucket:
    // the container is handed a url and fetches it back through the outbound
    // handler, which is the container's own side.
    BUCKET: undefined as unknown as R2Bucket,
    MEDIA: {
      idFromName: (name: string) => name,
      get: () => ({
        setOutboundByHost: (): Promise<void> => Promise.resolve(),
        fetch: answer,
      }),
    } as unknown as MediaEnv["MEDIA"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a container run that outlasts the deadline", () => {
  it("answers nothing found rather than waiting on", async () => {
    const noted = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await readMediaAtEdge(
      containerThat(() => new Promise<Response>(() => {})),
      {
        storageKey: KEY,
        contentType: "video/mp4",
        wantCover: false,
        limits: { runDeadlineMs: 20, toolTimeoutMs: 10 },
      },
    );

    expect(read).toEqual({ report: NOTHING_FOUND, cover: null });
    expect(noted).toHaveBeenCalledWith(
      "ingest_media_read_unfinished",
      expect.objectContaining({ storageKey: KEY, runDeadlineMs: 20 }),
    );
  });
});

describe("a container run that answers first", () => {
  // The deadline's timer is still pending when the answer arrives, and what it
  // would say is that the run never finished. Saying it where the outcome is
  // known is what keeps that out of the log for a run that did.
  it("says nothing about an unfinished run", async () => {
    const noted = vi.spyOn(console, "error").mockImplementation(() => {});

    const read = await readMediaAtEdge(
      containerThat(() => Promise.resolve(buildProbeAnswer(FILM, null))),
      {
        storageKey: KEY,
        contentType: "video/mp4",
        wantCover: false,
        limits: { runDeadlineMs: 20, toolTimeoutMs: 10 },
      },
    );
    // Past the deadline the run beat, which is when the timer would fire.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(read.report.streams[0]).toMatchObject({ width: 640, height: 360 });
    expect(noted).not.toHaveBeenCalledWith(
      "ingest_media_read_unfinished",
      expect.anything(),
    );
  });
});
