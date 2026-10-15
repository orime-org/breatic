// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The collaboration milestone and the consent snapshots worker and collab
 * events follow (inner#1442 design §4.4.5, §4.8, §4.9) — real PG + Redis.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  ADS_CONVERSION_QUEUE,
  claimFirstMilestone,
  createQueue,
  getUploadStatus,
  initCore,
  initServerAnalytics,
  loadLocales,
  reportCollaboratorFirstAction,
  resetServerAnalyticsForTest,
  runWithConsent,
  setAdsConversionConfigForTest,
  type OutgoingEvent,
} from "@breatic/core";
import { uploadGrantService } from "@breatic/domain";
import { CONSENT_REVISION, type ConsentSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const { projectService, studioService } = await import("@server/modules");

let sql: ReturnType<typeof postgres>;
const sent: OutgoingEvent[] = [];
const failures: string[] = [];
const ACCEPT: ConsentSnapshot = { analytics: true, ads: false };

/** Turn server analytics on, recording what it sends. */
function configureAnalytics(): void {
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    onError: (message) => void failures.push(message),
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
}

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  configureAnalytics();
});

afterEach(() => {
  sent.splice(0);
  failures.splice(0);
  setAdsConversionConfigForTest(undefined);
});

afterAll(async () => {
  resetServerAnalyticsForTest();
  await createQueue(ADS_CONVERSION_QUEUE).obliterate({ force: true });
  await sql?.end({ timeout: 5 });
});

/**
 * An account with its personal studio.
 * @returns Its ids.
 */
async function member(): Promise<{ id: string; studioId: string }> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, membership_tier)
    VALUES (${`collab-analytics-${crypto.randomUUID()}@example.test`}, 'pro') RETURNING id
  `;
  const studio = await studioService.createPersonalStudio(row!.id, `ca-${crypto.randomUUID().slice(0, 12)}`);
  return { id: row!.id, studioId: studio.id };
}

/**
 * A project owned by a fresh account, and a second account invited into it.
 * @returns The project, its owner and the collaborator.
 */
async function sharedProject(): Promise<{ projectId: string; studioId: string; ownerId: string; collaboratorId: string }> {
  const owner = await member();
  const collaborator = await member();
  const project = await projectService.create(owner.id, owner.studioId, "Shared", "shared", "canvas");
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project.id}, ${collaborator.id}, 'editor', ${owner.id})
  `;
  return { projectId: project.id, studioId: owner.studioId, ownerId: owner.id, collaboratorId: collaborator.id };
}

describe("collaborator_first_action", () => {
  it("reports a collaborator's first action once, and never the creator's", async () => {
    const { projectId, studioId, ownerId, collaboratorId } = await sharedProject();

    await reportCollaboratorFirstAction({ projectId, userId: ownerId, action: "space" }, ACCEPT);
    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "agent" }, ACCEPT);
    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "space" }, ACCEPT);

    expect(sent).toEqual([
      expect.objectContaining({
        event_type: "collaborator_first_action",
        user_id: collaboratorId,
        insert_id: `collab:${projectId}:${collaboratorId}`,
        event_properties: { studio_id: studioId, project_id: projectId, action: "agent" },
      }),
    ]);
    expect(failures).toEqual([]);
  });

  it("counts the first action under no consent as had, without sending it", async () => {
    const { projectId, collaboratorId } = await sharedProject();
    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "asset" });
    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "asset" }, ACCEPT);
    expect(sent).toEqual([]);
  });

  it("counts a first action reached before analytics was configured as had", async () => {
    const { projectId, collaboratorId } = await sharedProject();
    resetServerAnalyticsForTest();
    setAdsConversionConfigForTest(null);
    try {
      await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "asset" }, ACCEPT);
    } finally {
      configureAnalytics();
    }
    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "asset" }, ACCEPT);
    expect(sent).toEqual([]);
  });

  it("queues the owner's collaboration conversion under the owner's consent, once per owner", async () => {
    setAdsConversionConfigForTest({
      customerId: "1234567890",
      actions: { collaboration: "55" },
      credentials: { client_email: "svc@example.test", private_key: "key" },
    });
    const { projectId, ownerId, collaboratorId } = await sharedProject();
    const at = new Date().toISOString();
    await sql`
      UPDATE users SET consent_seen = ${sql.json({
        analytics: { value: false, revision: CONSENT_REVISION },
        ads: { value: true, revision: CONSENT_REVISION },
        reportedAt: new Date().toISOString(),
      })} WHERE id = ${ownerId}
    `;
    await sql`
      UPDATE users SET attribution = ${sql.json({ first: { gclid: "g", at }, last: { gclid: "g", at } })}
      WHERE id = ${ownerId}
    `;

    await reportCollaboratorFirstAction({ projectId, userId: collaboratorId, action: "generation" }, ACCEPT);
    expect(await getUploadStatus({ conversion: "collaboration", transactionId: `collab:${ownerId}` })).toBe("queued");

    const second = await member();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${second.id}, 'editor', ${ownerId})
    `;
    await reportCollaboratorFirstAction({ projectId, userId: second.id, action: "space" }, ACCEPT);
    const [{ n }] = await sql<[{ n: number }]>`
      SELECT count(*)::int AS n FROM ads_conversion_uploads WHERE transaction_id = ${`collab:${ownerId}`}
    `;
    expect(n).toBe(1);
  });
});

describe("consent snapshots", () => {
  it("keeps the uploading browser's consent on the upload grant", async () => {
    const me = await member();
    const project = await projectService.create(me.id, me.studioId, "Up", "up", "canvas");
    const { key } = await runWithConsent(ACCEPT, () =>
      uploadGrantService.issueUploadGrant({
        projectId: project.id,
        actingUserId: me.id,
        declaredSize: 10,
        taskType: "image",
        ext: ".png",
        expiresAt: new Date(Date.now() + 60_000),
        context: {},
      }),
    );
    const [row] = await sql<{ analytics_consent: unknown }[]>`
      SELECT analytics_consent FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(row!.analytics_consent).toEqual(ACCEPT);
  });

  it("claims each first milestone once per account, however many claim it at once", async () => {
    const me = await member();
    const claims = await Promise.all(
      Array.from({ length: 5 }, async () => claimFirstMilestone("first-generation", me.id)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimFirstMilestone("first-generation", me.id)).toBe(false);
    expect(await claimFirstMilestone("first-agent", me.id)).toBe(true);
  });
});
