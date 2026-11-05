// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type { Hono } from "hono";
import { initCore, loadLocales } from "@breatic/core";
import { activityRows, seedActivityProject, seedActivityUser } from "./helpers/account-activity-fixture.js";
import type { ActivityProject } from "./helpers/account-activity-fixture.js";

vi.mock("ai", () => ({ generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({ fullStream: (async function* () {})(), text: Promise.resolve(""), usage: Promise.resolve({ totalTokens: 0 }) }),
  stepCountIs: () => () => false, tool: (config: Record<string, unknown>) => config }));
vi.mock("@server/utils/send-best-effort-mail.js", () => ({ sendBestEffortMail: async (): Promise<void> => {} }));
initCore(process.env);
loadLocales();
let sql: ReturnType<typeof postgres>;
let app: Hono;
beforeAll(async () => { sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false }); app = (await import("@server/app.js")).createApp(); });
afterAll(async () => { await sql?.end({ timeout: 1 }); });

type Account = { userId: string; cookie: string };
interface Scene { owner: ActivityProject; member: Account; email: string; }

/**
 * Seed an existing team owner and a real maintainer with personal profiles.
 * @returns Authentic owner/member sessions and the member's mailbox.
 * @throws {Error} When fixture persistence fails.
 */
async function scene(): Promise<Scene> {
  const owner = await seedActivityProject(sql);
  const member = await seedActivityUser(sql);
  await sql`UPDATE users SET membership_tier='pro' WHERE id IN (${owner.userId},${member.userId})`;
  for (const account of [owner, member]) await sql`INSERT INTO studios(created_by_user_id,slug,type,name) VALUES(${account.userId},${`home-${randomUUID().slice(0, 16)}`},'personal','Personal')`;
  await sql`INSERT INTO studio_members(studio_id,user_id,role) VALUES(${owner.studioId},${member.userId},'maintainer')`;
  const [row] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id=${member.userId}`;
  return { owner, member, email: row!.email };
}

/**
 * Call an existing HTTP command under its actor's real session.
 * @param actor - The account actually sending the command.
 * @param method - Existing route method.
 * @param path - Existing route suffix.
 * @param body - Optional input.
 * @returns Actual HTTP response.
 * @throws {Error} When the request cannot execute.
 */
async function call(actor: Account, method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  return app.request(`/api/v1${path}`, { method, headers: { Cookie: actor.cookie, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

/**
 * Add a current real Project viewer without creating a user interaction.
 * @param s - The owned Project and its Studio maintainer.
 * @returns Nothing.
 * @throws {Error} When fixture insertion fails.
 */
async function viewer(s: Scene): Promise<void> {
  await sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${s.owner.projectId},${s.member.userId},'viewer')`;
}

/**
 * Read the request identity and share token created by the real command.
 * @param table - A fixed existing request table chosen by this test.
 * @param projectId - Existing Project.
 * @returns The latest pending request's id and share token.
 * @throws {Error} When no request was persisted.
 */
async function pending(table: "project_invitations" | "project_join_requests" | "role_upgrade_requests" | "project_transfers", projectId: string): Promise<{ id: string; share_token: string }> {
  const [row] = await sql<{ id: string; share_token: string }[]>`SELECT id,share_token FROM ${sql(table)} WHERE project_id=${projectId} AND status='pending' ORDER BY created_at DESC LIMIT 1`;
  if (!row) throw new Error("activity request fixture was not persisted");
  return row;
}

/**
 * Verify one command attributes its newly appended event only to its caller.
 * @param s - Two distinct real accounts.
 * @param actor - The account pressing this command.
 * @param command - The actual HTTP command and its approved success status.
 * @param status - Existing API success status.
 * @param newProject - Whether this command creates the attributed Project.
 * @returns The successful response body for follow-up state inspection.
 * @throws {Error} When command execution, activity lookup or an assertion fails.
 */
async function checkActor(s: Scene, actor: Account, command: () => Promise<Response>, status = 200, newProject = false): Promise<{ data: Record<string, unknown> }> {
  const before = await activityRows(sql, actor.userId);
  const other = actor.userId === s.owner.userId ? s.member : s.owner;
  const otherBefore = await activityRows(sql, other.userId);
  const response = await command();
  expect(response.status, await response.clone().text()).toBe(status);
  const rows = await activityRows(sql, actor.userId);
  expect(rows).toHaveLength(before.length + 1);
  expect(rows.slice(0, before.length)).toEqual(before);
  expect(rows.at(-1)).toMatchObject({ user_id: actor.userId, kind: "project_action" });
  const body = await response.json() as { data: Record<string, unknown> };
  expect(rows.at(-1)?.project_id).toBe(newProject ? body.data.id : s.owner.projectId);
  expect(await activityRows(sql, other.userId)).toEqual(otherBefore);
  return body;
}

describe("interactive Project command actor boundaries (inner#1893 P12)", () => {
  it("records Project create against the new Project, excluding lazy seed as another user action", async () => {
    const s = await scene();
    const response = await call(s.owner, "POST", "/projects", { studioId: s.owner.studioId, name: "Created", slug: `created-${randomUUID().slice(0, 12)}`, spaceType: "canvas" });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await response.json() as { data: { id: string } };
    expect((await activityRows(sql, s.owner.userId)).map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "project_action", project: body.data.id }]);
  });

  it("records an interactive duplicate as its caller", async () => {
    const s = await scene();
    await checkActor(s, s.owner, () => call(s.owner, "POST", `/projects/${s.owner.projectId}/duplicate`, {}), 201, true);
  });

  for (const operation of ["role", "remove", "leave"] as const) {
    it(`records member ${operation} for the actor and excludes the passive member`, async () => {
      const s = await scene(); await viewer(s);
      const actor = operation === "leave" ? s.member : s.owner;
      const path = operation === "leave" ? `/projects/${s.owner.projectId}/membership` : `/projects/${s.owner.projectId}/members/${s.member.userId}`;
      await checkActor(s, actor, () => call(actor, operation === "role" ? "PATCH" : "DELETE", path, operation === "role" ? { role: "editor" } : undefined));
    });
  }

  for (const flow of ["invite", "join", "upgrade", "transfer"] as const) {
    for (const phase of ["request", "withdraw", "confirm", "decline"] as const) {
      it(`records ${flow} ${phase} only for the authenticated command sender`, async () => {
        const s = await scene();
        if (flow === "upgrade" || flow === "transfer") await viewer(s);
        const path = `/projects/${s.owner.projectId}`;
        const table = flow === "invite" ? "project_invitations" : flow === "join" ? "project_join_requests" : flow === "upgrade" ? "role_upgrade_requests" : "project_transfers";
        const requestActor = flow === "invite" || flow === "transfer" ? s.owner : s.member;
        const requestPath = flow === "invite" ? `${path}/invitations` : flow === "join" ? `${path}/join-requests` : flow === "upgrade" ? `${path}/role-upgrade-requests` : `${path}/transfer-owner`;
        const body = flow === "invite" ? { email: s.email, role: "viewer" } : flow === "transfer" ? { toUserId: s.member.userId } : {};
        if (phase === "request") {
          await checkActor(s, requestActor, () => call(requestActor, "POST", requestPath, body), 201);
          return;
        }
        const created = await call(requestActor, "POST", requestPath, body);
        expect(created.status, await created.clone().text()).toBe(201);
        const row = await pending(table, s.owner.projectId);
        if (phase === "withdraw") {
          const withdrawPath = flow === "invite" ? `${path}/invitations/${row.id}` : flow === "join" ? `${path}/join-requests/mine` : flow === "upgrade" ? `/role-upgrade-requests/${row.id}` : `${path}/transfer/${row.id}`;
          await checkActor(s, requestActor, () => call(requestActor, "DELETE", withdrawPath));
        } else {
          const decider = flow === "invite" || flow === "transfer" ? s.member : s.owner;
          await checkActor(s, decider, () => call(decider, "POST", "/decisions/respond", {
            token: row.share_token, action: phase, ...(flow === "join" && phase === "confirm" ? { role: "viewer" } : {}),
          }));
        }
      });
    }
  }

  it("does not record another account's rejected owner-only member mutation", async () => {
    const s = await scene(); await viewer(s);
    const response = await call(s.member, "PATCH", `/projects/${s.owner.projectId}/members/${s.owner.userId}`, { role: "editor" });
    expect(response.status).toBe(403);
    expect(await activityRows(sql, s.member.userId)).toEqual([]);
    expect(await activityRows(sql, s.owner.userId)).toEqual([]);
  });
});
