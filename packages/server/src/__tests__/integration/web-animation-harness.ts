// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The real app, database and Redis the web-animation route suites drive (inner#1711, #1490), with payments on so a
 * credit hold, were one written, would be a real `credit_holds` row, and the fixtures they share: members and
 * Projects, executions written straight through the repository, grants, state steps and finished results.
 */

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, inject } from "vitest";
import {
  env,
  getNodeTaskConfig,
  getRedis,
  getStreamRedis,
  initCore,
  loadLocales,
  sessionCookieName,
  setSession,
  taskEventsStreamKey,
  timelineExecutionRepo,
  type Redis,
} from "@breatic/core";
import { webAnimationSourceRepo } from "@breatic/domain";
import { t, webAnimationSpaceDocName, type TimelineExecution } from "@breatic/shared";
import { seedDesignatedLot } from "@server/__tests__/integration/studio-credit-fixtures.js";

/** Where signed preview addresses point in these suites. */
export const PREVIEW_BASE_URL = "https://preview.timeline.test";

/** A signed-in project member. */
export interface Member { userId: string; cookie: string }

/** A Project with an owner, an editor and a viewer, and one Space id. */
export interface ProjectFixture {
  owner: Member;
  editor: Member;
  viewer: Member;
  studioId: string;
  projectId: string;
  spaceId: string;
}

/** What {@link WebAnimationHarness.insertExecution} writes; every field has a default. */
export interface ExecutionFixture {
  projectId: string;
  spaceId: string;
  actorUserId: string;
  kind?: TimelineExecution["kind"];
  origin?: "timeline" | "web_animation_space";
  input?: Record<string, unknown>;
}

/** The app, the database client and the shared fixtures. */
export interface WebAnimationHarness {
  readonly sql: ReturnType<typeof postgres>;
  readonly app: Hono;
  readonly signals: { channel: string; message: Record<string, unknown> }[];
  seedUser(): Promise<Member & { studioId: string }>;
  seedProject(credits?: number): Promise<ProjectFixture>;
  insertExecution(fixture: ExecutionFixture): Promise<TimelineExecution>;
  grant(executionId: string, projectId: string): Promise<void>;
  step(id: string, event: Parameters<typeof timelineExecutionRepo.transition>[0]["event"]): Promise<TimelineExecution>;
  succeed(execution: TimelineExecution, size?: { width: number; height: number; durationFrames: number }): Promise<{ id: string }>;
  holdsOf(studioId: string): Promise<{ reference_id: string; status: string; amount: number }[]>;
  grantedProjects(executionId: string): Promise<string[]>;
  signalsFor(projectId: string, spaceId: string): Promise<Record<string, unknown>[]>;
  /** Change versions published for a Space's document since the case began; a Motion Space's unless named. */
  executionChangesFor(projectId: string, spaceId: string, docNameOf?: (projectId: string, spaceId: string) => string): Promise<Record<string, unknown>[]>;
  expectNotFound(res: Response): Promise<void>;
  fillStorage(studioId: string, userId: string): Promise<void>;
}

const CREATE_INPUT = { prompt: "A red square", engine: "deepseek", aspect: "16:9", durationSeconds: 4, fps: { num: 24, den: 1 } };

/**
 * Start the app for one suite and register its hooks; call once at the top level of a test file.
 * @param appName - The database client's application name, so lock probes can tell it apart.
 * @returns The harness; `sql` and `app` are readable from `beforeAll` on.
 */
export function useWebAnimationHarness(appName: string): WebAnimationHarness {
  const suiteEnv = {
    ...process.env,
    PAYMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
    STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
    WEB_ANIMATION_PREVIEW_BASE_URL: PREVIEW_BASE_URL,
  };
  let sql: ReturnType<typeof postgres> | undefined;
  let app: Hono | undefined;
  let subscriber: Redis | undefined;
  const signals: { channel: string; message: Record<string, unknown> }[] = [];
  let seq = 0;
  let streamFrom = "0";

  beforeAll(async () => {
    initCore(suiteEnv);
    loadLocales();
    sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false, connection: { application_name: appName } });
    const { createApp } = await import("@server/app.js");
    app = createApp();
    subscriber = getStreamRedis().duplicate();
    subscriber.on("pmessage", (_pattern: string, channel: string, message: string) => {
      signals.push({ channel, message: JSON.parse(message) as Record<string, unknown> });
    });
    await subscriber.psubscribe(`${env.REDIS_KEY_PREFIX}:project:*:space-tasks:changed`);
  });

  beforeEach(() => {
    signals.length = 0;
    streamFrom = `${Date.now()}-0`;
  });

  afterAll(async () => {
    await subscriber?.quit();
    await sql?.end({ timeout: 1 });
    initCore(process.env);
  });

  /**
   * The database client, once the suite has started.
   * @returns It.
   */
  function db(): ReturnType<typeof postgres> {
    if (sql === undefined) throw new Error("The harness has not started");
    return sql;
  }

  /**
   * A session cookie for a user.
   * @param userId - Who signs in.
   * @returns The cookie header value.
   */
  async function sessionFor(userId: string): Promise<string> {
    const token = crypto.randomBytes(24).toString("hex");
    await setSession(getRedis(), token, userId);
    return `${sessionCookieName()}=${token}`;
  }

  const harness: WebAnimationHarness = {
    get sql() { return db(); },
    get app() {
      if (app === undefined) throw new Error("The harness has not started");
      return app;
    },
    signals,

    async seedUser() {
      const [user] = await db()<{ id: string }[]>`
        INSERT INTO users (email, email_verified) VALUES (${`wa-${seq++}-${crypto.randomUUID()}@example.test`}, true) RETURNING id
      `;
      const [studio] = await db()<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name)
        VALUES (${user!.id}, ${`wa-s-${crypto.randomBytes(8).toString("hex")}`}, 'personal', 'Personal') RETURNING id
      `;
      await db()`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
      return { userId: user!.id, studioId: studio!.id, cookie: await sessionFor(user!.id) };
    },

    async seedProject(credits = 10_000) {
      const owner = await harness.seedUser();
      const slug = `wa-p-${crypto.randomBytes(8).toString("hex")}`;
      const [project] = await db()<{ id: string }[]>`
        INSERT INTO projects (studio_id, created_by_user_id, name, slug, initial_space_type)
        VALUES (${owner.studioId}, ${owner.userId}, ${slug}, ${slug}, 'web_animation') RETURNING id
      `;
      const projectId = project!.id;
      await db()`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${owner.userId}, 'owner', null)`;
      const editor = await harness.seedUser();
      await db()`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${editor.userId}, 'editor', ${owner.userId})`;
      const viewer = await harness.seedUser();
      await db()`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${projectId}, ${viewer.userId}, 'viewer', ${owner.userId})`;
      if (credits > 0) await seedDesignatedLot(db(), { userId: owner.userId, studioId: owner.studioId, projectId }, credits);
      return { owner, editor, viewer, studioId: owner.studioId, projectId, spaceId: crypto.randomUUID() };
    },

    async insertExecution(fixture) {
      const kind = fixture.kind ?? "web_animation_create";
      const row = await timelineExecutionRepo.insert({
        projectId: fixture.projectId,
        spaceId: fixture.spaceId,
        actorUserId: fixture.actorUserId,
        kind,
        engine: kind === "web_animation_export" ? null : "deepseek",
        actionId: crypto.randomUUID(),
        input: fixture.input ?? CREATE_INPUT,
        inputHash: `sha256:${crypto.randomUUID()}`,
        deadlineAt: new Date(Date.now() + getNodeTaskConfig().default_budget_ms),
        origin: fixture.origin ?? "web_animation_space",
      });
      if (row === null) throw new Error("Fixture execution conflicted");
      return row;
    },

    async grant(executionId, projectId) {
      await db()`INSERT INTO timeline_execution_grants (execution_id, project_id, execution_created_at, execution_origin)
        SELECT id, ${projectId}, created_at, origin FROM timeline_executions WHERE id = ${executionId}`;
    },

    async step(id, event) {
      const result = await timelineExecutionRepo.transition({ id, event });
      if (!result.applied) throw new Error(`Fixture step ${event.type} refused`);
      return result.row;
    },

    async succeed(execution, size = { width: 1920, height: 1080, durationFrames: 96 }) {
      const running = await harness.step(execution.id, { type: "claim" });
      const source = await webAnimationSourceRepo.insert({
        executionId: execution.id,
        packageKey: `web-animation/${execution.projectId}/${execution.id}/index.html`,
        manifestKey: `web-animation/${execution.projectId}/${execution.id}/manifest.json`,
        packageSha256: "a".repeat(64),
        packageBytes: 600_000,
        manifestSha256: "b".repeat(64),
        runtimeVersion: "@hyperframes/core@0.8.186",
        fontSetVersion: 1,
        width: size.width,
        height: size.height,
        fpsNum: 24,
        fpsDen: 1,
        durationFrames: size.durationFrames,
      });
      await harness.step(execution.id, { type: "success", fence: running.fence, resultSourceVersionId: source.id });
      return source;
    },

    async holdsOf(studioId) {
      const rows = await db()<{ reference_id: string; status: string; amount: string }[]>`
        SELECT reference_id, status, amount::text AS amount FROM credit_holds WHERE studio_id = ${studioId} ORDER BY created_at, id
      `;
      return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
    },

    async grantedProjects(executionId) {
      const rows = await db()<{ project_id: string }[]>`
        SELECT project_id FROM timeline_execution_grants WHERE execution_id = ${executionId} AND deleted_at IS NULL ORDER BY project_id
      `;
      return rows.map((row) => row.project_id);
    },

    async signalsFor(projectId, spaceId) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return signals.filter((s) => s.channel.includes(projectId) && s.message.spaceId === spaceId).map((s) => s.message);
    },

    async executionChangesFor(projectId, spaceId, docNameOf = webAnimationSpaceDocName) {
      const docName = docNameOf(projectId, spaceId);
      const entries = await getStreamRedis().xrange(taskEventsStreamKey(), streamFrom, "+");
      return entries
        .map(([, fields]) => JSON.parse(fields[fields.indexOf("payload") + 1]!) as Record<string, unknown>)
        .filter((event) => event.docName === docName);
    },

    async expectNotFound(res) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 404, message: t("server.error.not_found") } });
    },

    async fillStorage(studioId, userId) {
      await db()`
        INSERT INTO studio_assets (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source, produced_by_user_id)
        VALUES (${studioId}, ${crypto.randomBytes(32).toString("hex")}, ${`image/wa-full-${crypto.randomUUID()}.png`},
          'https://cdn.test.invalid/x.png', ${"1000000000000000"}, 'image/png', 'image', 'upload', ${userId})
      `;
    },
  };
  return harness;
}
