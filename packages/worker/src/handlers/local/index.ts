/**
 * Dispatcher for worker-local (non-vendor) mini-tool handlers.
 *
 * `runLocalHandler` is called by `runMiniTool` when a registry entry
 * has `kind: 'local'`. It resolves the handler path (e.g. `"video/crop"`)
 * to a concrete implementation module, sets up a per-job temp dir, and
 * invokes the handler. On success the handler returns the same shape
 * `runMiniTool` expects for provider results (`{ url, cost?, ... }`).
 *
 * Phase 1 (T3): ZERO handlers registered. This dispatcher returns a
 * clear "not implemented" error for any `kind: 'local'` invocation.
 * Phase 2 lands the first handler (`video/crop`) alongside its
 * registry entry — wiring is already in place here.
 *
 * Adding a new local handler:
 *   1. Create `./<category>/<operation>.ts` exporting a default handler
 *      matching `LocalHandlerFn`.
 *   2. Add its `"<category>/<operation>"` key to `LOCAL_HANDLERS` below.
 *   3. Add `{ kind: 'local', handler: '<category>/<operation>' }` to
 *      `MINI_TOOL_REGISTRY`.
 */

import { createJobTempDir, cleanupJobTempDir } from "./runtime/tempdir.js";
import videoCrop from "./video/crop.js";
import videoSpeed from "./video/speed.js";
import videoCut from "./video/cut.js";
import videoAdjust from "./video/adjust.js";
import videoAudioDenoise from "./video/audioDenoise.js";
import videoStabilization from "./video/stabilization.js";
import videoSceneExtension from "./video/sceneExtension.js";
import videoHdrConversion from "./video/hdrConversion.js";

/**
 * Common shape returned by every local handler — matches the subset
 * of the vendor `provider.generateAsync` result that `runMiniTool` and
 * downstream persist/record logic consume.
 */
export interface LocalHandlerResult {
  /** Result URL (already uploaded to permanent storage by the handler). */
  url: string;
  /** Optional cover URL (video first-frame etc.). */
  cover_url?: string;
  /**
   * Cost unit (see `credits = cost * 100 * CREDIT_MULTIPLIER` in
   * `runMiniTool`). Local handlers that are free to users return 0.
   */
  cost?: number;
  /** Free-form additional fields — passed through to provider_result. */
  [key: string]: unknown;
}

export interface LocalHandlerContext {
  tempDir: string;
  jobId: string;
  taskType: string;
  toolName: string;
  /** Task owner — used as the storage key prefix (permanent URL scoping). */
  userId: string;
  /** Project ID — used inside the storage key (defaults to "default"). */
  projectId: string | undefined;
}

export type LocalHandlerFn = (
  params: Record<string, unknown>,
  ctx: LocalHandlerContext,
) => Promise<LocalHandlerResult>;

/**
 * Handler registry keyed by `"<category>/<operation>"`.
 *
 * Adding a new handler:
 *   1. Create `./<category>/<operation>.ts` with a default export
 *      matching `LocalHandlerFn`.
 *   2. Add the import + register the key below.
 *   3. Add `{ kind: 'local', handler: '<key>' }` to MINI_TOOL_REGISTRY.
 */
const LOCAL_HANDLERS: Readonly<Record<string, LocalHandlerFn>> = {
  "video/crop": videoCrop,
  "video/speed": videoSpeed,
  "video/cut": videoCut,
  "video/adjust": videoAdjust,
  "video/audio-denoise": videoAudioDenoise,
  "video/stabilization": videoStabilization,
  "video/scene-extension": videoSceneExtension,
  "video/hdr-conversion": videoHdrConversion,
  // Image local handlers removed (t3-phase4c pivot): image crop /
  // flipRotate / manual-adjust are sub-100ms Canvas operations — they
  // belong on the client. Video ops stay here (seconds-level FFmpeg
  // pipelines are the canonical "server-side heavy" case).
};

export interface RunLocalHandlerParams {
  handler: string;
  taskType: string;
  toolName: string;
  params: Record<string, unknown>;
  jobId: string;
  userId: string;
  projectId: string | undefined;
}

/**
 * Run a local handler by its registry `handler` path.
 *
 * @returns Result matching `LocalHandlerResult`
 * @throws `Error` if `handler` is not registered, or if the handler
 *   implementation throws
 */
export async function runLocalHandler(
  opts: RunLocalHandlerParams,
): Promise<LocalHandlerResult> {
  const fn = LOCAL_HANDLERS[opts.handler];
  if (!fn) {
    throw new Error(
      `Local handler '${opts.handler}' is not implemented. Register in ` +
        `LOCAL_HANDLERS (packages/worker/src/handlers/local/index.ts) and ` +
        `in MINI_TOOL_REGISTRY to enable.`,
    );
  }

  const tempDir = await createJobTempDir(opts.jobId);
  try {
    return await fn(opts.params, {
      tempDir,
      jobId: opts.jobId,
      taskType: opts.taskType,
      toolName: opts.toolName,
      userId: opts.userId,
      projectId: opts.projectId,
    });
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}
