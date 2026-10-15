// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lazy-seed for a project's meta document.
 *
 * After the yjs two-DB cutover, project creation writes only the
 * business rows — it no longer eager-seeds any Yjs doc (the yjs store is
 * a separate database). Instead, on the FIRST load of a meta doc that
 * has no row yet, this seeds — together — the first Space's CONTENT doc
 * AND the meta doc, using the `initial_space_type` chosen at create time
 * (read from the project row). The content doc is seeded FIRST so a
 * Space never becomes visible in meta before its content doc exists (the
 * same invariant `duplicateByProjectPrefix` upholds). This preserves
 * "project exists ⇒ meta + its first Space content doc exist" at read
 * time rather than write time.
 *
 * Convergence: the default Space id is a deterministic id derived from
 * the project id (shared `deriveId`), so two collab instances that both
 * load a fresh meta doc before either persists encode the SAME Space key
 * — the Yjs CRDT merge of their in-memory docs converges to ONE Space
 * rather than two. The DB insert is `ON CONFLICT DO NOTHING`, and the
 * loser of the race re-reads the winner's bytes.
 *
 * Fidelity (accepted degradation, per design): collab has no user repo,
 * so the seeded Space is attributed to a `system` placeholder. Nothing
 * backfills a name for it and nothing needs to — since #1882 the meta doc
 * carries no identity at all, and anyone rendering an actor resolves the
 * name from the project roster. The Space is named by its type
 * (`defaultSpaceName` — "Canvas" / "Document" / "Timeline"); the user
 * renames it afterwards.
 */

import {
  createLogger,
  defaultSpaceName,
  encodeInitialMetaState,
  getRedis,
  getSession,
  loadInitialSpaceType,
  projectActivitiesRepo,
  runWithConsent,
  serverAnalyticsOn,
  sessionCookieName,
} from "@breatic/core";
import {
  CONSENT_COOKIE_NAME,
  deriveId,
  encodeInitialSpaceContent,
  parseConsentCookie,
  parseDocName,
  spaceContentDocName,
} from "@breatic/shared";
import { readCookie } from "@collab/hooks/auth.js";
import { reportSpaceCreated } from "@collab/services/space-analytics.js";
import * as yjsDocumentsRepo from "@collab/services/yjs-documents.repo.js";

const logger = createLogger("lazy-seed");

/** Placeholder creator/actor — backfilled to the real user via awareness. */
const SYSTEM_ACTOR = "system";

/**
 * If `documentName` is a meta doc with no row yet, seed the project's
 * first Space — its content doc AND the meta doc, using the Space type
 * chosen at create time — and return the meta bytes; otherwise return
 * null (the caller's fetch result stands).
 * @param documentName - Full Yjs doc name being loaded
 * @param opener - The connection whose load triggered this, when there is one
 * @returns The seeded meta bytes, or null when no seed applies
 */
export async function lazySeedMeta(
  documentName: string,
  opener?: SeedOpener,
): Promise<Uint8Array | null> {
  const parsed = parseDocName(documentName);
  if (!parsed || parsed.kind !== "meta") return null;

  const { projectId } = parsed;
  // The Space type chosen at create time (stored on the project row);
  // defaults to canvas for a missing/legacy row.
  const kind = await loadInitialSpaceType(projectId);
  // Deterministic Space id (shared `deriveId`) so concurrent first-loads
  // across collab instances converge to one Space (see header).
  const spaceId = deriveId(projectId);

  // The Space's only name is the one on its tab, held in meta below — the
  // content document carries no name of its own.
  const spaceName = defaultSpaceName(kind);

  // Content doc FIRST, then meta — a Space must never be visible in meta
  // before its content doc exists. Both are `ON CONFLICT DO NOTHING` +
  // deterministically named, so concurrent first-loads converge.
  await yjsDocumentsRepo.seedInitialState(
    spaceContentDocName(projectId, spaceId, kind),
    encodeInitialSpaceContent(kind),
  );

  const bytes = encodeInitialMetaState({
    spaceId,
    kind,
    name: spaceName,
    createdBy: SYSTEM_ACTOR,
    ts: Date.now(),
  });

  const inserted = await yjsDocumentsRepo.seedInitialState(documentName, bytes);
  if (inserted) {
    // Winner of the seed race records the initial space:created
    // activity row (actor null = system; the meta-doc projectMessages
    // seed entry was retired with the feed move to PG, ADR 2026-07-04).
    // Best-effort: a failed audit row must not fail the project load.
    try {
      await projectActivitiesRepo.insert({
        projectId,
        actorUserId: null,
        type: "space:created",
        spaceId,
        payload: { spaceName: defaultSpaceName(kind) },
      });
    } catch (e) {
      logger.error({ err: e, projectId, spaceId }, "activity_seed_failed");
    }
    await reportSeededSpace({ projectId, spaceId, spaceType: kind }, opener);
    return bytes;
  }
  // Lost the insert race (another connection/instance seeded first):
  // return the persisted winner so every loader converges on one doc.
  return (await yjsDocumentsRepo.fetchDocData(documentName)) ?? bytes;
}

/** The handshake of the connection that loaded the meta doc first. */
export interface SeedOpener {
  /** The WebSocket upgrade request's headers, carrying its cookies. */
  readonly requestHeaders?: Headers;
  /** The connection context the auth hook returned, when this load came from one. */
  readonly context?: unknown;
}

/**
 * Report the project's first Space as created by whoever opened the project,
 * under that browser's consent cookie (inner#1442 design §4.4.5). A load
 * started by an auth-time lookup carries the cookies but no user, so the
 * user is read from the session cookie then.
 * @param space - The seeded Space.
 * @param space.projectId - Its project.
 * @param space.spaceId - Its id.
 * @param space.spaceType - Its kind.
 * @param opener - The loading connection's handshake.
 */
async function reportSeededSpace(
  space: { projectId: string; spaceId: string; spaceType: string },
  opener: SeedOpener | undefined,
): Promise<void> {
  if (!opener || !serverAnalyticsOn()) return;
  // Reporting is best-effort: a cookie it cannot read must not fail the project's load.
  try {
    const cookies = opener.requestHeaders?.get("cookie") ?? undefined;
    const gpc = opener.requestHeaders?.get("sec-gpc") === "1";
    const consent = parseConsentCookie(readCookie(cookies, CONSENT_COOKIE_NAME) ?? undefined, Date.now(), gpc);
    if (!consent.analytics) return;
    const fromContext = (opener.context as { user?: { id?: string } } | undefined)?.user?.id;
    const token = readCookie(cookies, sessionCookieName());
    const userId =
      fromContext && fromContext !== SYSTEM_ACTOR ? fromContext : token ? await getSession(getRedis(), token) : null;
    if (!userId) return;
    await runWithConsent(consent, () => reportSpaceCreated({ ...space, userId, via: "seed" }));
  } catch (err) {
    logger.warn({ err, projectId: space.projectId }, "space_created_report_failed");
  }
}
