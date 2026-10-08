// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The wire between the media container and the Worker (#209 + #210, §4.2).
 *
 * Three things travel together and two of them are binary, so the answer is
 * `multipart/form-data`: a `meta` part naming the streams and the duration,
 * a `cover` part carrying the PNG when a frame was lifted, and a `preview` part
 * carrying the WebP when one was cut.
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

import { NOTHING_FOUND } from "@ingest/media-metadata.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import {
  COVER_CONTENT_TYPE,
  PREVIEW_CONTENT_TYPE,
} from "@ingest/probe-command.js";

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
  /** Whether to cut a preview: of the cover for a video, of the object else. */
  wantPreview: boolean;
  /** How long the preview tool may run. */
  previewTimeoutMs: number;
  /**
   * When the Worker stops waiting for this answer, in epoch ms. An instant
   * rather than a span, so time a cold start spent before the request arrived
   * is counted.
   */
  deadlineAt: number;
}

/** What the Worker got back from one container run. */
export interface ProbeAnswer {
  report: ProbeReport;
  /** The cover frame, when one was lifted. */
  cover: Uint8Array | null;
  /** The preview, when one was cut. */
  preview: Uint8Array | null;
  /** Whether a container answered at all, which an empty report cannot say. */
  answered: boolean;
}

/**
 * Write one container answer.
 * @param report - What ffprobe found.
 * @param cover - The PNG frame, or null when none was lifted.
 * @param preview - The WebP preview, or null when none was cut.
 * @returns The response the container sends.
 */
export function buildProbeAnswer(
  report: ProbeReport,
  cover: Uint8Array | null,
  preview: Uint8Array | null = null,
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
  if (preview !== null) {
    form.set(
      "preview",
      new File([preview], "preview.webp", { type: PREVIEW_CONTENT_TYPE }),
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

/** An answer that could not be read, which is what no answer reads as. */
export const UNREAD_ANSWER: ProbeAnswer = Object.freeze({
  report: NOTHING_FOUND,
  cover: null,
  preview: null,
  answered: false,
});

/**
 * One binary part of an answer, when it is there.
 * @param form - The answer's parts.
 * @param name - Which part.
 * @returns Its bytes, or null.
 */
async function bytesOf(form: FormData, name: string): Promise<Uint8Array | null> {
  const part = form.get(name);
  return part instanceof File ? new Uint8Array(await part.arrayBuffer()) : null;
}

/**
 * Read one container answer.
 * @param response - What the container sent.
 * @returns The report, the cover and the preview, each empty when it could not
 *   be read.
 * @throws {never} Anything unreadable answers as nothing found.
 */
export async function readProbeAnswer(
  response: Response,
): Promise<ProbeAnswer> {
  let form: FormData;
  try {
    form = await response.formData();
  } catch {
    return UNREAD_ANSWER;
  }

  const meta = form.get("meta");
  if (typeof meta !== "string") return UNREAD_ANSWER;
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return UNREAD_ANSWER;
  }
  // Parsing says the text was JSON, nothing more. What the caller does with
  // this is index `streams`, so the shape is what has to hold.
  if (!isProbeReport(parsed)) return UNREAD_ANSWER;

  return {
    report: parsed,
    cover: await bytesOf(form, "cover"),
    preview: await bytesOf(form, "preview"),
    answered: true,
  };
}
