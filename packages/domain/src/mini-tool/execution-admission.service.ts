// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TaskStatusType } from "@breatic/shared";
import type { MiniToolPlannedRequest, MiniToolSourceBinding } from "@breatic/shared/mini-tools";
import type { PreparedVideoRemoveBackground } from "@domain/mini-tool/remove-background-preparation.service.js";

/** The original server-owned execution stored under tasks.params.miniToolExecution. */
export interface AcceptedMiniToolExecution {
  schemaVersion: 1;
  tool: MiniToolPlannedRequest["tool"];
  taskId: string;
  projectId: string;
  spaceId: string;
  targetNodeIds: string[];
  binding: MiniToolSourceBinding;
  sourceKey: string;
  draft: MiniToolPlannedRequest["draft"];
  analysisRefs: MiniToolPlannedRequest["analysis_refs"];
  outputs: MiniToolPlannedRequest["outputs"];
  model: string;
  provider: PreparedVideoRemoveBackground["provider"];
  body: PreparedVideoRemoveBackground["params"];
  credits: number;
  requestFingerprint: string;
  planFingerprint: string;
}

/** The narrow admission response, without prescribing terminal public result projection. */
export interface MiniToolExecutionAdmission {
  taskId: string;
  status: TaskStatusType;
}

/** The immutable task namespace, separate from analysis and worker-only steps. */
export interface MiniToolExecutionTaskParams extends Record<string, unknown> {
  miniToolExecution: AcceptedMiniToolExecution;
}

/**
 * Admit or replay a planned execution before its transport adapter starts it.
 * @param body - The complete press-frozen submission.
 * @param userId - The authenticated actor whose project role must be checked.
 * @param start - The application's row, hold and queue adapter, invoked only by the durable winner.
 * @returns The original task identity and its current status.
 * @throws {Error} Until the durable admission contract is implemented.
 */
export async function acceptMiniToolExecution(
  body: MiniToolPlannedRequest,
  userId: string,
  start: (accepted: AcceptedMiniToolExecution) => Promise<"pending" | "failed">,
): Promise<MiniToolExecutionAdmission> {
  void body;
  void userId;
  void start;
  throw new Error("Planned execution admission is not implemented");
}
