// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The wire between the media container and the Worker (#209 + #210, §4.2).
 *
 * Two things travel together and one of them is binary, so the answer is
 * `multipart/form-data`: a `meta` part naming the streams and the duration,
 * and a `cover` part carrying the PNG when a frame was lifted.
 *
 * Both halves live in one file because they are one agreement. The container
 * imports the writer, the Worker imports the reader, and a change to either
 * shape is a change to a function the other one calls.
 *
 * Reading is total: anything that does not parse comes back as nothing found.
 * The container's answer decides whether a node shows a resolution and a
 * poster, never whether the upload succeeded, so an unreadable one degrades
 * rather than failing anything.
 */

import type { ProbeReport } from "@ingest/media-metadata.js";
import { COVER_CONTENT_TYPE } from "@ingest/probe-command.js";

/** An empty report, which is what an unreadable answer amounts to. */
const NOTHING_FOUND: ProbeReport = { streams: [], durationSeconds: null };

/**
 * The port the container listens on and the Worker connects to.
 *
 * Here rather than in either side, for the same reason the format is: two
 * copies of it drift, and the way that shows up is a connection refused with
 * nothing saying which of the two moved.
 */
export const PROBE_PORT = 8080;

/** The one endpoint the container serves. */
export const PROBE_PATH = "/probe";

/** What one run is asked to do. */
export interface ProbeRequest {
  /** Where to read the object, which is a hostname the Worker intercepts. */
  objectUrl: string;
  /** Whether to lift a cover frame, decided from the ticket's content type. */
  wantCover: boolean;
  /**
   * How long one tool may run, reads included. It comes off
   * `config/storage.yaml`, which checks it against the deadline the Worker
   * holds the whole run to.
   */
  toolTimeoutMs: number;
}

/** What the Worker got back from one container run. */
export interface ProbeAnswer {
  report: ProbeReport;
  /** The cover frame, when one was lifted. */
  cover: Uint8Array | null;
}

/**
 * Write one container answer.
 * @param report - What ffprobe found.
 * @param cover - The PNG frame, or null when none was lifted.
 * @returns The response the container sends.
 */
export function buildProbeAnswer(
  report: ProbeReport,
  cover: Uint8Array | null,
): Response {
  const form = new FormData();
  form.set("meta", JSON.stringify(report));
  if (cover !== null) {
    // Typed from the arguments that produced it: the container is what decided
    // the format, and this type is stored on the R2 object.
    form.set(
      "cover",
      new File([cover], "cover.png", { type: COVER_CONTENT_TYPE }),
    );
  }
  return new Response(form);
}

/**
 * Whether a parsed meta part is a report at all.
 * @param parsed - What the JSON came out as.
 * @returns Whether the caller may index it.
 */
function isProbeReport(parsed: unknown): parsed is ProbeReport {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { streams?: unknown }).streams)
  );
}

/**
 * Read one container answer.
 * @param response - What the container sent.
 * @returns The report and the cover, each empty when it could not be read.
 * @throws {never} Anything unreadable answers as nothing found.
 */
export async function readProbeAnswer(
  response: Response,
): Promise<ProbeAnswer> {
  let form: FormData;
  try {
    form = await response.formData();
  } catch {
    return { report: NOTHING_FOUND, cover: null };
  }

  const meta = form.get("meta");
  if (typeof meta !== "string") return { report: NOTHING_FOUND, cover: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return { report: NOTHING_FOUND, cover: null };
  }
  // Parsing says the text was JSON, nothing more. What the caller does with
  // this is index `streams`, so the shape is what has to hold.
  if (!isProbeReport(parsed)) return { report: NOTHING_FOUND, cover: null };
  const report = parsed;

  const cover = form.get("cover");
  if (!(cover instanceof File)) return { report, cover: null };
  return { report, cover: new Uint8Array(await cover.arrayBuffer()) };
}
