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
}

export type LocalHandlerFn = (
  params: Record<string, unknown>,
  ctx: LocalHandlerContext,
) => Promise<LocalHandlerResult>;

/**
 * Handler registry keyed by `"<category>/<operation>"`.
 *
 * Empty in phase 1 — handlers come online in phase 2 (video/crop first).
 */
const LOCAL_HANDLERS: Readonly<Record<string, LocalHandlerFn>> = {};

/**
 * Run a local handler by its registry `handler` path.
 *
 * @param handler - `"<category>/<operation>"` path registered in
 *   `LOCAL_HANDLERS`
 * @param taskType - `taskType` from the job (image/video/audio/...)
 * @param toolName - `toolName` from the job (crop/speed/...)
 * @param params - Job params (source URL + operation-specific fields)
 * @param jobId - BullMQ job id (for temp dir naming)
 * @returns Result matching `LocalHandlerResult`
 * @throws `Error` if `handler` is not registered, or if the handler
 *   implementation throws
 */
export async function runLocalHandler(
  handler: string,
  taskType: string,
  toolName: string,
  params: Record<string, unknown>,
  jobId: string,
): Promise<LocalHandlerResult> {
  const fn = LOCAL_HANDLERS[handler];
  if (!fn) {
    throw new Error(
      `Local handler '${handler}' is not implemented (phase 1 scaffold ` +
        `— no handlers registered yet). Register in LOCAL_HANDLERS and ` +
        `MINI_TOOL_REGISTRY to enable.`,
    );
  }

  const tempDir = await createJobTempDir(jobId);
  try {
    return await fn(params, { tempDir, jobId, taskType, toolName });
  } finally {
    await cleanupJobTempDir(tempDir);
  }
}
