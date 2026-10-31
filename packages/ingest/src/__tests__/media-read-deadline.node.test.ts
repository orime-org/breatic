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
 * Runs on Node with an explicitly advanced clock: these cases judge which
 * answer wins, not how soon the runner schedules the test. Even on Node a
 * real 20ms deadline can expire before an immediate stub is reached under CI
 * load. Fake Date and deadline timers together; leave the I/O scheduling used
 * to read the response body on its real clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a container run that outlasts the deadline", () => {
  // The task's deadline is the only bound on the wait (inner#1367).
  it("answers nothing found rather than waiting on", async () => {
    const noted = vi.spyOn(console, "error").mockImplementation(() => {});
    const deadlineAt = Date.now() + 20;

    const reading = readMediaAtEdge(
      containerThat(() => new Promise<Response>(() => {})),
      { storageKey: KEY, contentType: "video/mp4", wantCover: false, deadlineAt },
    );
    await vi.advanceTimersByTimeAsync(20);
    const read = await reading;

    expect(read).toEqual({
      report: NOTHING_FOUND,
      cover: null,
      preview: null,
      peaks: null,
      agentPicture: null,
      answered: false,
      upright: null,
      missed: "unfinished",
    });
    expect(noted).toHaveBeenCalledWith(
      "ingest_media_read_unfinished",
      expect.objectContaining({ storageKey: KEY, deadlineAt }),
    );
  });

  it("starts no run when the deadline has already come", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let started = false;

    const read = await readMediaAtEdge(
      containerThat(() => {
        started = true;
        return Promise.resolve(buildProbeAnswer(FILM, null));
      }),
      { storageKey: KEY, contentType: "video/mp4", wantCover: false, deadlineAt: Date.now() - 1 },
    );

    expect(started).toBe(false);
    expect(read.answered).toBe(false);
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
      { storageKey: KEY, contentType: "video/mp4", wantCover: false, deadlineAt: Date.now() + 20 },
    );
    // Past the deadline the run beat, which is when the timer would fire.
    await vi.advanceTimersByTimeAsync(60);

    expect(read.report.streams[0]).toMatchObject({ width: 640, height: 360 });
    expect(noted).not.toHaveBeenCalledWith(
      "ingest_media_read_unfinished",
      expect.anything(),
    );
  });
});
