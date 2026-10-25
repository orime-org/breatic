// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Durable phases for one logical media segment. */
export type LongMediaSegmentStatus =
  | "planned"
  | "encoding"
  | "oversize"
  | "stored"
  | "ready"
  | "superseded"
  | "paused"
  | "failed";

/** An already validated segment lifecycle event. */
export type LongMediaSegmentEvent =
  | { type: "run" | "oversize" | "measured" | "registered" | "split" | "transient" | "fatal" | "stop" | "adopt" | "length-repartition" }
  | { type: "resume"; checkpoint: "planned" | "oversize" | "stored" };

/** Reduce one segment phase after its event evidence has been checked. */
export function transitionLongMediaSegment(
  status: LongMediaSegmentStatus,
  event: LongMediaSegmentEvent,
): LongMediaSegmentStatus {
  if (status === "superseded" || status === "failed") return status;

  switch (event.type) {
    case "run":
      return status === "planned" ? "encoding" : status;
    case "oversize":
      return status === "encoding" ? "oversize" : status;
    case "measured":
      return status === "encoding" ? "stored" : status;
    case "registered":
      return status === "stored" ? "ready" : status;
    case "split":
      return status === "oversize" ? "superseded" : status;
    case "transient":
      return status === "encoding" ? "planned" : status;
    case "fatal":
      return status === "planned" || status === "encoding" || status === "oversize" || status === "stored"
        ? "failed"
        : status;
    case "stop":
      return status === "planned" || status === "encoding" || status === "oversize" || status === "stored"
        ? "paused"
        : status;
    case "resume":
      return status === "paused" ? event.checkpoint : status;
    case "adopt":
      return status === "planned" ? "ready" : status;
    case "length-repartition":
      return status === "ready" ? "superseded" : status;
  }
}
