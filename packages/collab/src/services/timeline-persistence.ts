// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from "yjs";
import { createLogger, projectAuthService, projectsRepo } from "@breatic/core";
import { parseDocName, readTimelineDocument } from "@breatic/shared";
import type { TimelineDocumentV1, TimelinePersistenceRequest, TimelinePersistenceResponse, TimelineStoreAttempt } from "@breatic/shared";
import { fetchDocData } from "@collab/services/yjs-documents.repo.js";

const logger = createLogger("timeline-persistence");
type FailureCode = Extract<TimelinePersistenceResponse, { ok: false }>["error"]["code"];

/** Identity and write permission resolved from the authenticated content connection. */
export interface TimelinePersistenceContext {
  documentName: string;
  userId: string;
  readOnly: boolean;
  requestStore(documentName: string): Promise<TimelineStoreAttempt>;
}

/**
 * Return a typed refusal without attaching any unconfirmed edit records.
 * @param id - The requesting connection's correlation id.
 * @param code - The stable refusal category.
 * @param message - Technical context for the client or operator.
 * @returns The correlated persistence refusal.
 * @throws {never} Never.
 */
function failure(id: string, code: FailureCode, message: string): TimelinePersistenceResponse {
  return { version: 1, id, type: "timeline:persistence:result", ok: false, error: { code, message } };
}

/**
 * Query durable edit receipts or request the current document's real store attempt.
 * @param context - The authenticated content connection and store scheduler.
 * @param request - The strictly validated persistence request.
 * @returns A response describing actual persisted records.
 * @throws {never} Never.
 */
export async function handleTimelinePersistenceRpc(context: TimelinePersistenceContext, request: TimelinePersistenceRequest): Promise<TimelinePersistenceResponse> {
  const parsed = parseDocName(context.documentName);
  if (parsed?.kind !== "timeline") return failure(request.id, "FORBIDDEN", "A Timeline content connection is required");
  try {
    const [role, studioId] = await Promise.all([
      projectAuthService.loadProjectRole(context.userId, parsed.projectId),
      projectsRepo.findLiveOwnerStudioId(parsed.projectId),
    ]);
    if (role === null || studioId === undefined) return failure(request.id, "FORBIDDEN", "Current Project access is required");
    let attempt: TimelineStoreAttempt | undefined;
    if (request.type === "timeline:persistence:retry") {
      if ((role !== "owner" && role !== "editor") || context.readOnly) return failure(request.id, "FORBIDDEN", "The current content connection is read-only");
      attempt = await context.requestStore(context.documentName);
    }

    const state = await fetchDocData(context.documentName);
    if (state === null) return failure(request.id, "NOT_FOUND", "Persisted Timeline content is unavailable");
    const snapshot = new Y.Doc();
    let persisted: TimelineDocumentV1;
    try {
      Y.applyUpdate(snapshot, state);
      persisted = readTimelineDocument(snapshot);
    } catch (err) {
      logger.error({ err, documentName: context.documentName, userId: context.userId }, "timeline_persistence_format_unsupported");
      return failure(request.id, "UNSUPPORTED_DOCUMENT", "Persisted content does not use the supported Timeline format");
    } finally {
      snapshot.destroy();
    }

    const persistedRecords = request.payload.actionIds.flatMap((id) => {
      const record = persisted.nativeEdits[id];
      return record?.actionId === id ? [record] : [];
    });
    const included = new Set(persistedRecords.map((record) => record.actionId));
    return {
      version: 1, id: request.id, type: "timeline:persistence:result", ok: true,
      result: {
        documentVersion: 1,
        persistedRecords,
        missingActionIds: request.payload.actionIds.filter((id) => !included.has(id)),
        ...(attempt !== undefined && { attempt }),
      },
    };
  } catch (err) {
    logger.error({ err, documentName: context.documentName, userId: context.userId }, "timeline_persistence_request_failed");
    return failure(request.id, "INTERNAL", "Timeline persistence could not be verified");
  }
}
