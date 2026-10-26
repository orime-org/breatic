// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";

import {
  transitionLongMediaSegment,
  type LongMediaSegmentEvent,
} from "@ingest/jobs/long-media-segment.js";

const statuses = ["planned", "encoding", "oversize", "stored", "ready", "superseded", "paused", "failed"] as const;
const events = [
  "run",
  "oversize",
  "measured",
  "registered",
  "split",
  "transient",
  "fatal",
  "stop",
  "resume-planned",
  "resume-oversize",
  "resume-stored",
  "adopt",
  "length-repartition",
] as const;

const accepted: Partial<Record<string, string>> = {
  "planned:run": "encoding",
  "planned:fatal": "failed",
  "planned:stop": "paused",
  "planned:adopt": "ready",
  "encoding:oversize": "oversize",
  "encoding:measured": "stored",
  "encoding:transient": "planned",
  "encoding:fatal": "failed",
  "encoding:stop": "paused",
  "oversize:split": "superseded",
  "oversize:fatal": "failed",
  "oversize:stop": "paused",
  "stored:registered": "ready",
  "stored:fatal": "failed",
  "stored:stop": "paused",
  "ready:stop": "ready",
  "ready:length-repartition": "superseded",
  "paused:resume-planned": "planned",
  "paused:resume-oversize": "oversize",
  "paused:resume-stored": "stored",
};

const cases = statuses.flatMap((status) => events.map((event) => ({
  status,
  event,
  expected: accepted[`${status}:${event}`] ?? status,
})));

describe("transitionLongMediaSegment", () => {
  it.each(cases)("moves $status on $event to $expected", ({ status, event, expected }) => {
    const actual = transitionLongMediaSegment(status, segmentEvent(event));

    expect(actual).toBe(expected);
  });
});

/** Convert a table event name into its reducer event. */
function segmentEvent(event: (typeof events)[number]): LongMediaSegmentEvent {
  switch (event) {
    case "resume-planned": return { type: "resume", checkpoint: "planned" };
    case "resume-oversize": return { type: "resume", checkpoint: "oversize" };
    case "resume-stored": return { type: "resume", checkpoint: "stored" };
    case "measured": return { type: "measured", measured: { sha256: "a".repeat(64), sizeBytes: 1, contentType: "audio/mpeg" } };
    default: return { type: event };
  }
}
