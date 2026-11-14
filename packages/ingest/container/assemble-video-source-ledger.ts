// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type {
  PhysicalVideoProbe, MatroskaPhysicalVideoProbe, OwnedVideoPresentation, VideoEditSpan, VideoSourceLedgerV2, VideoSourceRun,
} from "@shared/upload/video-source-ledger-types.js";
import { projectPresentationTable, rational, type PresentationRational, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
import { planVideoPresentationTimeline, videoAudioSampleIndex, VIDEO_AUDIO_SAMPLE_RATE, type VideoTimelineFrame } from "@shared/mini-tools/video-presentation-timeline.js";
import { videoPlanOutput, type VideoPlanOutput, type VideoPlanSource } from "@shared/mini-tools/video-encode-plan.js";
import type { IsoBmffEdit, IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import { exactPresentationTime } from "@ingest/container/iso-bmff-presentation.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import { assembleExplicitIsoVideoPresentation } from "@ingest/container/explicit-iso-video-presentation.js";
import { assembleUneditedIsoVideoPresentation } from "@ingest/container/unedited-iso-video-presentation.js";
import { assembleMatroskaVideoPresentation } from "@ingest/container/matroska-video-presentation.js";

/** Already admitted source identity and frozen pure-planning ceilings. */
interface SourceLedgerAssemblyBase {
  sourceFingerprint: string;
  attempt: { jobId: string; deadlineAt: number };
}
/** Already admitted source identity and the complete facts the container parsed from it. */
export type VideoSourceLedgerV2Input = SourceLedgerAssemblyBase & ({
  kind: "iso_bmff";
  metadata: IsoBmffMetadata;
  physical: PhysicalVideoProbe;
  /** The selected audio track, or null when the source has no audio. */
  audioTrackId: number | null;
} | {
  kind: "matroska";
  metadata: MatroskaMetadata;
  physical: MatroskaPhysicalVideoProbe;
});

/** No frame ceiling: the stored ledger covers every upload (inner#1306), so the planners get the largest one they accept. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Assemble the stored source ledger v2 and its compact presentation table in one pure call.
 * @param input - Accepted identity and the complete parsed container and physical facts.
 * @returns The ledger and the compact table, which is the ledger's own presentation.
 * @throws {Error} When the format owner rejects the source; `code` is `unsupported_rate` for a non-positive edit rate and `no_presented_frames` when nothing is presented.
 */
export function assembleVideoSourceLedgerV2(input: VideoSourceLedgerV2Input): { ledger: VideoSourceLedgerV2; table: VideoPresentationTable } {
  let presentation: OwnedVideoPresentation;
  let videoEdits: VideoEditSpan[] | null = null;
  let audioEdits: VideoEditSpan[] | null = null;
  if (input.kind === "matroska") presentation = assembleMatroskaVideoPresentation(input.metadata, input.physical, UNBOUNDED);
  else {
    const explicit = assembleExplicitIsoVideoPresentation(input.metadata, input.physical, UNBOUNDED);
    presentation = explicit ?? assembleUneditedIsoVideoPresentation(input.metadata, input.physical, UNBOUNDED);
    if (explicit !== null) {
      const video = trackOf(input.metadata, input.physical.trackId);
      videoEdits = editSpans(video.edits!, input.metadata.movieTimescale, video.mediaTimescale);
    }
    if (input.audioTrackId !== null) {
      const audio = trackOf(input.metadata, input.audioTrackId);
      audioEdits = audio.edits === null ? null : editSpans(audio.edits, input.metadata.movieTimescale, audio.mediaTimescale);
    }
  }
  if (presentation.frames.length === 0) throw ledgerError("no_presented_frames", "The edits present no frame");
  const table = projectPresentationTable(presentation.frames);
  const ledger: VideoSourceLedgerV2 = {
    schemaVersion: 2, sourceFingerprint: input.sourceFingerprint, producerVersion: 2, attempt: { ...input.attempt }, presentation: table,
    source: { timeBase: { ...input.physical.sourceTimeBase }, runs: sourceRuns(presentation.frames.map((frame) => sourceTick(frame.sourcePtsTicks))) },
    videoEdits, audioEdits,
  };
  return { ledger, table };
}

/** Everything a presentation plan is assembled from: real frames and edits in original time and the resolved source facts. */
export interface VideoPresentationPlanInput {
  /** Real frames in presentation order; `sourcePtsTicks` is on `sourceTimeBase`. */
  frames: readonly { sourcePtsTicks: string; start: PresentationRational; declaredEnd: PresentationRational | null }[];
  sourceTimeBase: PresentationRational;
  emptyEdits: readonly { start: PresentationRational; end: PresentationRational }[];
  segmentDuration: PresentationRational | null;
  videoSpans: readonly VideoEditSpan[] | null;
  /** The video track's media duration, which decides whether a single edit is no edit. */
  mediaDuration: PresentationRational;
  /**
   * Where the media starts in source time: its first composition time, 0 when omitted. An edit that only removes the
   * composition delay of reordered frames starts there.
   */
  mediaStart?: PresentationRational;
  /** The selected audio's window and edits in original time, or null without audio. */
  audio: { start: PresentationRational; end: PresentationRational; spans: readonly VideoEditSpan[] | null } | null;
  display: { width: number; height: number };
  colorMatrix: string;
  source: VideoPlanSource;
  policy: { singleFrameDurationMs: number; emptyFill: "black" | "transparent" };
}
/** The S6a presentation plan as the container assembles it; the shared ledger schema is its validator. */
export interface AssembledVideoPresentationPlan {
  display: { width: number; height: number; duration: PresentationRational };
  colorMatrix: string;
  source: VideoPlanSource;
  output: VideoPlanOutput;
  policy: VideoPresentationPlanInput["policy"];
  presentation: VideoPresentationTable;
  originMapping: {
    timeBase: PresentationRational;
    origin: PresentationRational;
    entries: ({ kind: "source"; start: number; count: number; step: number } | { kind: "derived-empty" })[];
    firstSource: { supportStart: PresentationRational; lead: { kind: "derived-lead"; start: PresentationRational } | null };
    lastSource: { support: "declared" | "previous-max" | "single-frame"; supportEnd: PresentationRational; hold: { kind: "derived-hold"; end: PresentationRational } | null };
  };
  videoSpans: VideoEditSpan[] | null;
  audioSpans: VideoEditSpan[] | null;
  segmentDuration: PresentationRational | null;
}

/**
 * Assemble the presentation plan (§4.2, §4.2.1, §7.16) from the S6a timeline: the audio window is snapped to the 48 kHz grid
 * first, a single rate-1 edit from 0 over the whole media is recorded as no edit, spans are rebased by the origin, source
 * ticks become greedy canonical runs between derived-empty frames and the output conversion follows the source.
 * @param input - Frames, edits, audio window and resolved source facts.
 * @returns The plan.
 * @throws {Error} With `code` `no_presented_frames` when nothing is presented; `RangeError` when the timeline rejects the times.
 */
export function assembleVideoPresentationPlan(input: VideoPresentationPlanInput): AssembledVideoPresentationPlan {
  if (input.frames.length === 0) throw ledgerError("no_presented_frames", "The edits present no frame");
  /**
   * Snap an original time to the output audio sample grid.
   * @param time - The time.
   * @returns The nearest sample's time.
   * @throws {RangeError} When the time is not an exact rational.
   */
  const snap = (time: PresentationRational): PresentationRational => exactPresentationTime(BigInt(videoAudioSampleIndex(time)), BigInt(VIDEO_AUDIO_SAMPLE_RATE));
  const audioStart = input.audio === null ? null : snap(input.audio.start);
  const audioEnd = input.audio === null ? null : snap(input.audio.end);
  const timeline = planVideoPresentationTimeline({
    frames: input.frames.map(({ start, declaredEnd }) => ({ start, declaredEnd })), emptyEdits: input.emptyEdits,
    segmentDuration: input.segmentDuration, audioStart, audioEnd, singleFrameDurationMs: input.policy.singleFrameDurationMs,
  });
  const entries: AssembledVideoPresentationPlan["originMapping"]["entries"] = [];
  let ticks: number[] = [];
  for (const frame of timeline.frames) {
    if (frame.kind === "source") { ticks.push(sourceTick(input.frames[frame.occurrence]!.sourcePtsTicks)); continue; }
    entries.push(...sourceRuns(ticks).map((run) => ({ kind: "source" as const, ...run })), { kind: "derived-empty" });
    ticks = [];
  }
  entries.push(...sourceRuns(ticks).map((run) => ({ kind: "source" as const, ...run })));
  const sources = timeline.frames.filter((frame): frame is Extract<VideoTimelineFrame, { kind: "source" }> => frame.kind === "source");
  const first = sources[0]!;
  const last = sources.at(-1)!;
  if (last.support.rule === "next-start") throw new Error("The last real frame cannot end at a next start");
  const origin = rational(timeline.origin);
  /**
   * Rebase spans onto the presentation timeline.
   * @param spans - Spans laid out in original time.
   * @returns The spans with presentationStart less the origin.
   * @throws {RangeError} When a time is not an exact rational.
   */
  const rebase = (spans: readonly VideoEditSpan[]): VideoEditSpan[] => spans.map((span) => {
    const [n, d] = rational(span.presentationStart);
    return { ...span, presentationStart: exactPresentationTime(n * origin[1] - origin[0] * d, d * origin[1]) };
  });
  return {
    display: { width: input.display.width, height: input.display.height, duration: timeline.end },
    colorMatrix: input.colorMatrix, source: { ...input.source }, output: videoPlanOutput(input.source), policy: { ...input.policy },
    presentation: projectPresentationTable(timeline.frames),
    originMapping: {
      timeBase: { ...input.sourceTimeBase }, origin: timeline.origin, entries,
      firstSource: { supportStart: first.support.start, lead: first.derivedLead === null ? null : { kind: "derived-lead", start: first.derivedLead.start } },
      lastSource: { support: last.support.rule, supportEnd: last.support.end, hold: last.derivedHold === null ? null : { kind: "derived-hold", end: last.derivedHold.end } },
    },
    videoSpans: input.videoSpans === null || coversWholeMedia(input.videoSpans, input.mediaStart ?? { numerator: "0", denominator: "1" }, input.mediaDuration) ? null : rebase(input.videoSpans),
    audioSpans: input.audio === null || input.audio.spans === null ? null : rebase(input.audio.spans),
    segmentDuration: input.segmentDuration,
  };
}

/**
 * Whether the edits are one rate-1 span from the media start over the whole media from movie time 0, which presents the media
 * unedited and which a stream copy keeps: an edit that starts later (after an empty edit) moves the media by that much, which
 * the origin alone does not carry.
 * @param spans - The video edits.
 * @param mediaStart - Where the media starts in source time.
 * @param mediaDuration - The video track's media duration.
 * @returns Whether the edits are no edit.
 * @throws {RangeError} When a time is not an exact rational.
 */
function coversWholeMedia(spans: readonly VideoEditSpan[], mediaStart: PresentationRational, mediaDuration: PresentationRational): boolean {
  if (spans.length !== 1) return false;
  const [start, end, rate, at] = [rational(spans[0]!.sourceStart), rational(spans[0]!.sourceEnd), rational(spans[0]!.rate), rational(spans[0]!.presentationStart)];
  const [from, media] = [rational(mediaStart), rational(mediaDuration)];
  // start = from, end = from + media and presentationStart = 0, compared as exact fractions.
  return start[0] * from[1] === from[0] * start[1] && end[0] * from[1] * media[1] === (from[0] * media[1] + media[0] * from[1]) * end[1] && rate[0] === rate[1]
    && at[0] === 0n;
}

/**
 * The one ISO track with this id.
 * @param metadata - Parsed ISO metadata.
 * @param trackId - The track id.
 * @returns The track.
 * @throws {Error} When no track or more than one has this id.
 */
function trackOf(metadata: IsoBmffMetadata, trackId: number): IsoBmffMetadata["tracks"][number] {
  const matches = metadata.tracks.filter((track) => track.trackId === trackId);
  if (matches.length !== 1) throw new Error("Expected one ISO track with the selected id");
  return matches[0]!;
}

/**
 * The non-empty, non-zero edits of an ISO edit list as spans laid out in movie time.
 * @param edits - The track's edit list.
 * @param movieTimescale - Movie ticks per second.
 * @param mediaTimescale - The track's media ticks per second.
 * @returns Spans in presentation order.
 * @throws {Error} With `code` `unsupported_rate` for a non-positive rate.
 */
export function editSpans(edits: readonly IsoBmffEdit[], movieTimescale: string, mediaTimescale: string): VideoEditSpan[] {
  const movie = BigInt(movieTimescale);
  const media = BigInt(mediaTimescale);
  const spans: VideoEditSpan[] = [];
  let at = 0n;
  for (const edit of edits) {
    const rate = BigInt(edit.mediaRateFixed16_16);
    if (rate <= 0n) throw ledgerError("unsupported_rate", "Edit rates must be positive");
    const duration = BigInt(edit.segmentDurationMovieTicks);
    const mediaTime = BigInt(edit.mediaTimeTrackTicks);
    if (mediaTime !== -1n && duration > 0n) {
      // The edit presents source [m, m + d·rate) from movie time `at`.
      spans.push({
        sourceStart: exactPresentationTime(mediaTime, media),
        sourceEnd: exactPresentationTime(mediaTime * movie * 65536n + duration * rate * media, media * movie * 65536n),
        presentationStart: exactPresentationTime(at, movie),
        rate: exactPresentationTime(rate, 65536n),
      });
    }
    at += duration;
  }
  return spans;
}

/**
 * A presented frame's source tick as a safe number.
 * @param ticks - The decimal tick string.
 * @returns The tick.
 * @throws {Error} With `code` `invalid_ledger` when the tick is not a safe integer.
 */
function sourceTick(ticks: string): number {
  const value = Number(ticks);
  if (!/^-?\d+$/u.test(ticks) || !Number.isSafeInteger(value)) throw ledgerError("invalid_ledger", "Source ticks must be safe integers");
  return value;
}

/**
 * Greedy canonical run-length encoding of source ticks: a tick extends the last run when it continues its progression, or when the last run has one frame and the tick increases.
 * @param ticks - One source tick per presented frame.
 * @returns The runs; a single-frame run steps by 0.
 * @throws {never} Never.
 */
function sourceRuns(ticks: readonly number[]): VideoSourceRun[] {
  const runs: VideoSourceRun[] = [];
  for (const tick of ticks) {
    const run = runs.at(-1);
    if (run !== undefined && run.count === 1 && tick > run.start) { run.step = tick - run.start; run.count = 2; } else if (run !== undefined && run.count > 1 && tick === run.start + run.count * run.step) run.count += 1;
    else runs.push({ start: tick, count: 1, step: 0 });
  }
  return runs;
}

/**
 * A producer failure carrying the code the ledger state stores.
 * @param code - The failure code.
 * @param message - What failed.
 * @returns The error.
 * @throws {never} Never.
 */
function ledgerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
