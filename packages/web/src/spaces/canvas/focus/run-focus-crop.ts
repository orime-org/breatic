// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Focus-crop orchestration (#1782, #1580): a confirmed marquee becomes a
 * standalone uploaded asset in the panel node's `focusImages`.
 *
 * Pipeline: export the crop (offscreen canvas, natural pixels) → wrap the
 * blob as a PNG File named from the source-node snapshot → run it through
 * the standard media-upload pipeline (hash → ticket dedup → parts to the
 * ingest Worker), the ticket naming the image the crop becomes. Once the
 * bytes are registered, collab adds that image to the node's pool; the page
 * writes nothing. The pending rail entry, under the same id, is the caller's
 * local state: it goes once the bytes are sent (the node's `focusUploads`,
 * written by collab, shows the crop from then until it lands), or through
 * `onFailure`.
 */

import { MAX_FOCUS_NAME, newId, t, type NodeTaskEntry, type TaskFailureReason } from '@breatic/shared';
import { miniToolPlannedRequestSchema, type MiniToolPlannedRequest, type MiniToolPresentationRef, type VideoToolSourceRef } from '@breatic/shared/mini-tools';
import { miniToolsApi, type MiniToolPlannedRunAnswer } from '@web/data/api/mini-tools';
import { toast } from '@web/lib/toast';
import { canvasSessions } from '@web/stores/canvas-session';
import { runOnce, spaceTaskIntent, type RunOnceOutcome } from '@web/stores/task-actions-in-flight';
import { plannedRunRefusalText } from '@web/spaces/canvas/mini-tool/start-planned-video-run';

import {
  isUploadFailureReason,
  type UploadFailureReason,
} from '@web/data/upload/media-upload';
import type { CropRect } from '@web/lib/crop-math';
import type { CropSource } from '@web/spaces/canvas/focus/crop-export';
import { uploadFailureMessageKey } from '@web/spaces/canvas/upload-failure';

/** Everything `runFocusCrop` needs injected (all unit-mockable). */
export interface FocusCropDeps {
  /** Export the natural-pixel crop of the source as a PNG blob. */
  exportCrop: (source: CropSource, crop: CropRect) => Promise<Blob>;
  /**
   * Upload the file as the named focus image, resolving once the upload ended
   * well (throws on failure) — production binds the standard media upload
   * with the panel node's Space and node. `onSent` is called once the bytes are
   * sent and only the server's registration is left.
   */
  uploadFile: (file: File, projectId: string, focusImage: FocusCropImage, onSent: () => void) => Promise<unknown>;
  /**
   * Failure sink, discriminated by stage (for the toast wording). Two of these
   * are not retryable and must not share the retryable wording: `hash` means
   * the browser could not fingerprint the crop, whose remedy is a reload, and
   * `storage` means the account is out of room, whose remedy is the admin's to
   * apply. The upload pipeline already tells these apart, so this carries its
   * verdict out rather than folding everything but `hash` into `upload`.
   */
  onFailure: (stage: 'export' | UploadFailureReason) => void;
}

/** The image a crop becomes, as its upload names it; its address comes from the registered asset. */
export interface FocusCropImage {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** What one confirmed marquee carries into the pipeline. */
export interface FocusCropParams {
  /** The crop's id: its pending entry's, and the image's once it lands. */
  id: string;
  /** The source node's asset URL (the content being cropped). */
  sourceUrl: string;
  /** The source node's display name, snapshotted at crop time. */
  sourceName: string;
  /**
   * For a video source, the frame the user parked on, in seconds; `null` for
   * a still image. Required rather than optional so the object literals that
   * build these params cannot omit it. The `exportCrop` assignment is outside
   * that reach: parameter contravariance accepts an implementation that never
   * reads this field, which is what the end-to-end test in
   * `focus/__tests__/crop-export.test.ts` holds down.
   */
  sourceTimeSeconds: number | null;
  /** The confirmed crop in natural (source-resolution) pixels. */
  crop: CropRect;
  /** Owning project (authorizes the ticket). */
  projectId: string;
}

/**
 * Build the upload filename for a crop: `focus-<source snapshot>.png`,
 * sanitized to the filename rules the ticket endpoint enforces (no path
 * separators / control chars; ≤255 chars) with a `crop` fallback when nothing
 * survives.
 * @param sourceName - The source node's display name.
 * @returns A filename the ticket endpoint accepts.
 */
export function focusCropFilename(sourceName: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars IS the intent (mirrors the ticket endpoint's whitelist)
  const cleaned = sourceName.replace(/[/\\\x00-\x1f\x7f]/g, '').slice(0, 200);
  return `focus-${cleaned.length > 0 ? cleaned : 'crop'}.png`;
}

/**
 * Run one confirmed focus crop. The returned promise settles once the browser's
 * half is over: the bytes are sent, a dedup hit answered, or it failed. Collab
 * adds the image, so the page may leave from then on (the Space's leave guard
 * waits on this). The wait for the upload's ending goes on and reports a
 * failure through `deps.onFailure`. Never throws.
 * @param params - The confirmed crop (id, source URL / name, natural rect, project).
 * @param deps - Injected export / upload / failure sinks.
 * @returns Once the browser's half is over.
 */
export function runFocusCrop(
  params: FocusCropParams,
  deps: FocusCropDeps,
): Promise<void> {
  return new Promise((sent) => {
    void (async (): Promise<void> => {
      let blob: Blob;
      try {
        blob = await deps.exportCrop(
          { url: params.sourceUrl, timeSeconds: params.sourceTimeSeconds },
          params.crop,
        );
      } catch {
        deps.onFailure('export');
        sent();
        return;
      }
      try {
        const file = new File([blob], focusCropFilename(params.sourceName), {
          type: 'image/png',
        });
        await deps.uploadFile(file, params.projectId, {
          id: params.id,
          name: params.sourceName,
          width: params.crop.width,
          height: params.crop.height,
        }, () => sent());
      } catch (err) {
        // The upload pipeline tags every refusal it can tell apart, so the caller
        // can offer the right remedy. Anything it did not tag is transient.
        const tagged = err instanceof Error ? err.message : '';
        deps.onFailure(isUploadFailureReason(tagged) ? tagged : 'upload');
      }
      sent();
    })();
  });
}

/**
 * The sentence a failed focus crop shows.
 *
 * A reason that names its cause reads as the canvas's upload sentence for it;
 * the catch-all and a transfer read as the crop's own.
 * @param stage - Where it failed: the export, or why the upload ended.
 * @returns The message key.
 */
export function focusFailureMessageKey(stage: 'export' | UploadFailureReason): string {
  if (stage === 'export') return 'canvas.generatePanel.focusExportFailed';
  if (stage === 'upload' || stage === 'transfer') return 'canvas.generatePanel.focusUploadFailed';
  return uploadFailureMessageKey(stage);
}

/** One video focus crop this browser started and has not yet seen end (frames-split §7.18 L). */
export interface VideoFocusCropRun { spaceId: string; panelNodeId: string; admitted: boolean }

// The placeholders that are video crops, by run_id: the canvas layer settles only these; image crops end with their upload.
// Module state, so a canvas remounted by a tab switch still settles crops it started.
const videoCropRuns = new Map<string, VideoFocusCropRun>();
const runListeners = new Set<() => void>();
let runRevision = 0;

/**
 * Records a change to the video crop runs and tells the subscribers.
 * @throws {never} Never.
 */
function notifyRuns(): void {
  runRevision += 1;
  for (const listener of runListeners) listener();
}

/**
 * The video crops this browser waits on.
 * @returns The runs by run_id.
 * @throws {never} Never.
 */
export function videoFocusCropRuns(): ReadonlyMap<string, VideoFocusCropRun> {
  return videoCropRuns;
}

/**
 * Subscribes to changes of the video crop runs, for `useSyncExternalStore`.
 * @param listener - Called on each change.
 * @returns The unsubscribe.
 * @throws {never} Never.
 */
export function subscribeVideoFocusCropRuns(listener: () => void): () => void {
  runListeners.add(listener);
  return () => { runListeners.delete(listener); };
}

/**
 * The revision of the video crop runs, for `useSyncExternalStore`.
 * @returns A number that changes with every change.
 * @throws {never} Never.
 */
export function videoFocusCropRunsRevision(): number {
  return runRevision;
}

/**
 * Ends one video crop: its placeholder goes, and the canvas layer stops settling it. A Space closed meanwhile has no
 * session left and nothing to remove.
 * @param spaceId - Its Space.
 * @param runId - Its run_id.
 * @throws {never} Never.
 */
export function endVideoFocusCrop(spaceId: string, runId: string): void {
  canvasSessions.peek(spaceId)?.getState().removePendingFocusUpload(runId);
  if (videoCropRuns.delete(runId)) notifyRuns();
}

/** What one confirmed video marquee hands the press (frames-split §5.5 admission row). */
export interface VideoFocusCropPress {
  projectId: string;
  spaceId: string;
  /** The node whose Generate panel picks the crop: the run's only output. */
  panelNodeId: string;
  /** The boxed video node, bound as the draft's source. */
  source: VideoToolSourceRef;
  /** The source node's display name, frozen into the plan. */
  sourceName: string;
  /** The selected version the marquee was drawn over. */
  presentationRef: MiniToolPresentationRef;
  /** The grid frame the player showed. */
  frameIndex: number;
  /** The crop in P.display pixels. */
  crop: CropRect;
}

/**
 * The planned request of one video focus crop (frames-split §5.5 admission and plan shape rows): the panel node is the one
 * output, a `frame` recipe with the crop; the boxed video is `draft.source`; the source name is cut to `MAX_FOCUS_NAME`.
 * @param press - The confirmed marquee.
 * @param runId - The request's run id, also the placeholder's key.
 * @returns The request.
 * @throws {z.ZodError} When the press does not make a valid planned request.
 */
export function videoFocusCropRequest(press: VideoFocusCropPress, runId: string): MiniToolPlannedRequest {
  const crop = { x: press.crop.x, y: press.crop.y, width: press.crop.width, height: press.crop.height };
  return miniToolPlannedRequestSchema.parse({
    tool: 'video.focus-crop', project_id: press.projectId, space_id: press.spaceId, run_id: runId, analysis_refs: [], presentation_ref: structuredClone(press.presentationRef),
    draft: { version: 1, draftId: newId(), revision: newId(), source: structuredClone(press.source), inputs: [],
      params: { frameIndex: press.frameIndex, crop, sourceName: press.sourceName.slice(0, MAX_FOCUS_NAME) } },
    outputs: [{ outputIndex: 0, nodeId: press.panelNodeId, recipe: { kind: 'frame', frameIndex: press.frameIndex, crop } }],
  });
}

/**
 * Send one video focus crop (frames-split §5.5 admission and result feedback rows, §7.18): a placeholder keyed by the request's
 * `run_id` appears at once and is counted by the three cap checks; each confirm is its own press under a run-once intent named
 * by its run_id. A final admission refusal removes the placeholder and says why; a released press removes it without a toast
 * of its own (run-once already said the result is unknown). An admitted crop keeps it until the canvas layer sees the end.
 * @param press - The confirmed marquee; the caps and the source state were checked before.
 * @returns The run-once outcome.
 * @throws {never} Refusals settle the placeholder.
 */
export function runVideoFocusCrop(press: VideoFocusCropPress): Promise<RunOnceOutcome<MiniToolPlannedRunAnswer>> {
  const runId = newId();
  const body = videoFocusCropRequest(press, runId);
  canvasSessions.of(press.spaceId).getState().addPendingFocusUpload({ id: runId, nodeId: press.panelNodeId, name: press.sourceName.slice(0, MAX_FOCUS_NAME) });
  videoCropRuns.set(runId, { spaceId: press.spaceId, panelNodeId: press.panelNodeId, admitted: false });
  notifyRuns();
  return runOnce(spaceTaskIntent('mini-tool', press.spaceId, runId, 'video.focus-crop'), {
    scope: 'mini-tool',
    prepare: () => body,
    send: (key, request) => miniToolsApi.runPlanned(request, key),
    onDone: () => {
      const run = videoCropRuns.get(runId);
      if (run !== undefined) { videoCropRuns.set(runId, { ...run, admitted: true }); notifyRuns(); }
      return undefined;
    },
    onFailure: (error) => { endVideoFocusCrop(press.spaceId, runId); toast.error(plannedRunRefusalText(error, t)); },
  }).then((outcome) => { if (outcome.kind === 'released') endVideoFocusCrop(press.spaceId, runId); return outcome; });
}

/** The panel node's task row for one placeholder, as the canvas layer reads it from the task list. */
export type VideoFocusCropRow = Pick<NodeTaskEntry, 'status' | 'startedAt' | 'budgetMs' | 'errorMessage'>;

/** The reason a row ends with when its person cancels it while it waits for a running slot (inner#1968 design 3.9). */
const CANCELLED: TaskFailureReason = 'cancelled';

/**
 * The row the canvas layer reads for one admitted crop from its panel node's task list.
 * @param entry - The entry whose taskId is the run_id, or none.
 * @returns Its row, or `cleared` when the list holds none.
 * @throws {never} Never.
 */
export function videoFocusCropRowOf(entry: VideoFocusCropRow | undefined): VideoFocusCropRead['row'] {
  return entry === undefined ? 'cleared' : { status: entry.status, startedAt: entry.startedAt, budgetMs: entry.budgetMs, errorMessage: entry.errorMessage };
}

/** The panel node's task row and result marker for one placeholder, as the canvas layer read them (§7.18). */
export interface VideoFocusCropRead {
  /** The row whose taskId is the run_id: `admitting` before the press is answered, `cleared` when absent after admission. */
  row: 'admitting' | 'cleared' | VideoFocusCropRow;
  /** `focusCropOutcomes[run_id]`, absent until collab handled the append. */
  outcome: 'added' | 'refused' | undefined;
  /** Wall clock, ms. */
  now: number;
}

/** What the canvas layer does with one placeholder. */
export interface VideoFocusCropSettlement {
  placeholder: 'keep' | 'remove';
  toast: null | 'referencePoolFull' | 'error';
  /** When a done row without its marker must be read again (its startedAt + budgetMs); null otherwise. */
  recheckAt: number | null;
}

const KEEP: VideoFocusCropSettlement = { placeholder: 'keep', toast: null, recheckAt: null };
const REMOVE: VideoFocusCropSettlement = { placeholder: 'remove', toast: null, recheckAt: null };

/**
 * The §7.18 outcome table: a marker decides on its own (added removes, refused removes and says the pool is full); a row the
 * user cancelled while it waited removes silently; any other failed or expired row removes and says so; a done row without a marker waits for its task deadline; a row cleared after admission
 * without a marker removes silently; admission still waiting or a running row keeps the card.
 * @param read - What was read.
 * @returns The settlement.
 * @throws {never} Never.
 */
export function videoFocusCropSettlement(read: VideoFocusCropRead): VideoFocusCropSettlement {
  if (read.row === 'admitting') return KEEP;
  if (read.outcome === 'added') return REMOVE;
  if (read.outcome === 'refused') return { placeholder: 'remove', toast: 'referencePoolFull', recheckAt: null };
  if (read.row === 'cleared') return REMOVE;
  if (read.row.status === 'running') return KEEP;
  if (read.row.status === 'failed' && read.row.errorMessage === CANCELLED) return REMOVE;
  if (read.row.status === 'failed' || read.row.status === 'expired') return { placeholder: 'remove', toast: 'error', recheckAt: null };
  const deadline = Date.parse(read.row.startedAt) + read.row.budgetMs;
  return read.now >= deadline ? REMOVE : { placeholder: 'keep', toast: null, recheckAt: deadline };
}
