// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Persisted enterprise information exercised through the actual consumer services. */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { getMembershipLimits, getMembershipReadingForUser, getLimitsForStudio } from "@breatic/core";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as projectService from "@server/modules/project/project.service.js";
import * as studioInvites from "@server/modules/studio/studioInvite.service.js";
import * as projectInvites from "@server/modules/project-invite/projectInvite.service.js";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { readAccountMembership } from "@server/modules/account/membership.service.js";
import { call, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

const suite = useInternalApp("enterprise-consumers");
const negotiated = { team_studios: 2, projects_per_studio: 3, concurrent_editors: 5, studio_members: 2, project_members: 1, storage_bytes: 1 };
const future = "2099-01-01T00:00:00.000Z";
const past = "2000-01-01T00:00:00.000Z";
type Limits = typeof negotiated;
interface Account { id: string; email: string; studioId: string; slug: string }

/** Seed ordinary identity and a personal studio; enterprise information always uses signed HTTP. */
async function account(tier = "pro"): Promise<Account> {
  const id = randomUUID(); const studioId = randomUUID(); const email = `${id}@example.test`;
  await suite.sql`insert into users(id,email,email_verified,membership_tier) values(${id},${email},true,${tier})`;
  await suite.sql`insert into studios(id,created_by_user_id,slug,name,type) values(${studioId},${id},${studioId},'Consumer','personal')`;
  await suite.sql`insert into studio_members(studio_id,user_id,role) values(${studioId},${id},'admin')`;
  return { id, email, studioId, slug: studioId };
}

/** Persist negotiated information using the public contract of the signed internal endpoint. */
async function save(a: Account, limits: Limits = negotiated, expiresAt = future, revision: number | null = null, tier = "pro"): Promise<void> {
  const result = await call(suite.baseUrl, `/internal/v1/accounts/${a.id}/enterprise-membership`, {
    idempotencyKey: `bo-${randomUUID()}`,
    body: { targetTier: "enterprise", expiresAt, entryTimezone: "UTC", contractNumber: "ENT-CONSUMER", limits, expectedRevision: revision, expectedStoredTier: tier },
  });
  expect(result.status).toBe(200);
  expect(result.json).toMatchObject({ status: "applied", after: { enterprise: { revision: (revision ?? 0) + 1, limits } } });
}

/** Seed pre-existing projects so the gate itself never limits its fixture. */
async function seedProject(a: Account, archived = false): Promise<string> {
  const id = randomUUID();
  await suite.sql`insert into projects(id,studio_id,created_by_user_id,name,slug,archived_at,archived_by_user_id) values(${id},${a.studioId},${a.id},'Existing',${id},${archived ? new Date() : null},${archived ? a.id : null})`;
  await suite.sql`insert into project_members(project_id,user_id,role) values(${id},${a.id},'owner')`;
  return id;
}

/** Invoke the real create path with an unused slug. */
async function createProject(a: Account): Promise<Awaited<ReturnType<typeof projectService.create>>> {
  return projectService.create(a.id, a.studioId, "Created", randomUUID(), "canvas");
}

/** Seed account-owned usage through actual asset rows. */
async function bytes(a: Account, size: number): Promise<void> {
  const key = randomUUID();
  await suite.sql`insert into studio_assets(studio_id,produced_by_user_id,content_hash,storage_key,file_url,mime_type,kind,source,size_bytes)
    values(${a.studioId},${a.id},${key},${key},${`https://example.test/${key}.png`},'image/png','image','upload',${size})`;
}

/** Transfer the governing role as an existing Studio management write would. */
async function transfer(from: Account, to: Account): Promise<void> {
  await suite.sql.begin(async (tx) => {
    await tx`select id from studios where id=${from.studioId} for update`;
    await tx`update studio_members set role='maintainer' where studio_id=${from.studioId} and user_id=${from.id}`;
    await tx`insert into studio_members(studio_id,user_id,role) values(${from.studioId},${to.id},'admin')`;
  });
}

describe("saved enterprise information reaches actual consumers", () => {
  it("creates team studios up to the saved cap and refuses another after expiry preserving existing studios", async () => {
    const a = await account(); await save(a, { ...negotiated, team_studios: 1 });
    await expect(studioService.createTeamStudio(a.id, "Allowed", randomUUID())).resolves.toMatchObject({ type: "team" });
    await expect(studioService.createTeamStudio(a.id, "Full", randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    await save(a, { ...negotiated, team_studios: 999 }, past, 1, "enterprise");
    await expect(studioService.createTeamStudio(a.id, "Expired", randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect((await readAccountMembership(a.id)).usage.teamStudios).toBe(1);
  });

  it("serializes actual enterprise team-studio creates at the last saved slot", async () => {
    const a = await account(); await save(a, { ...negotiated, team_studios: 1 });
    const gate = postgres(inject("DATABASE_URL"), { max: 1 });
    let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const opened = new Promise<void>((resolve) => { release = resolve; });
    const holding = gate.begin(async (tx) => { await tx`select id from users where id=${a.id} for update`; locked(); await opened; });
    let one: Promise<unknown> | undefined; let two: Promise<unknown> | undefined;
    try {
      await ready;
      one = studioService.createTeamStudio(a.id, "One", randomUUID()); void one.catch(() => {});
      await waitUntilBlockedOn(suite.sql, ["users", "for update"], 1);
      two = studioService.createTeamStudio(a.id, "Two", randomUUID()); void two.catch(() => {});
      await waitUntilBlockedOn(suite.sql, ["users", "for update"], 2);
      release(); await holding;
      const results = await Promise.allSettled([one, two]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await readAccountMembership(a.id)).usage.teamStudios).toBe(1);
    } finally { release(); await holding; await Promise.allSettled([one, two]); await gate.end({ timeout: 1 }); }
  });

  it("applies the saved project ceiling to create, duplicate and restore", async () => {
    const a = await account(); await save(a);
    const source = await createProject(a);
    const copied = await projectService.duplicate(source.id, a.id);
    await projectService.archive(copied.id, a.id);
    await expect(projectService.restore(copied.id, a.id)).resolves.toBeUndefined();
    const third = await createProject(a);
    await expect(createProject(a)).rejects.toMatchObject({ statusCode: 409 });
    await expect(projectService.duplicate(source.id, a.id)).rejects.toMatchObject({ statusCode: 409 });
    await projectService.archive(third.id, a.id); await createProject(a);
    await expect(projectService.restore(third.id, a.id)).rejects.toMatchObject({ statusCode: 409 });
    const [archived] = await suite.sql`select archived_at from projects where id=${third.id}`;
    expect(archived!.archived_at).not.toBeNull();
  });

  it("rejects all three project additions on expiry while preserving old objects", async () => {
    const a = await account(); await save(a, { ...negotiated, projects_per_studio: 20 });
    const source = await seedProject(a); const archived = await seedProject(a, true);
    for (let n = 1; n < getMembershipLimits("base").projects_per_studio; n++) await seedProject(a);
    await save(a, { ...negotiated, projects_per_studio: 999 }, past, 1, "enterprise");
    await expect(createProject(a)).rejects.toMatchObject({ statusCode: 409 });
    await expect(projectService.duplicate(source, a.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(projectService.restore(archived, a.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await suite.sql`select id from projects where studio_id=${a.studioId} and deleted_at is null`).toHaveLength(11);
  });

  it("keeps a complete old 20-limit decision across an actual count blocked during the saved expired-999 update with 25 objects", async () => {
    const a = await account(); const old = { ...negotiated, projects_per_studio: 20 };
    const changed = { team_studios: 999, projects_per_studio: 999, concurrent_editors: 999, studio_members: 999, project_members: 999, storage_bytes: 999 };
    await save(a, old); for (let n = 0; n < 25; n++) await seedProject(a);
    expect((await getMembershipReadingForUser(a.id)).limits).toEqual(old);
    const gate = postgres(inject("DATABASE_URL"), { max: 1 });
    let release!: () => void; let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const opened = new Promise<void>((resolve) => { release = resolve; });
    const holding = gate.begin(async (tx) => { await tx`lock table projects in access exclusive mode`; locked(); await opened; });
    let pending: Promise<unknown> | undefined;
    try {
      await ready; pending = createProject(a); void pending.catch(() => {});
      await waitUntilBlockedOn(suite.sql, ["projects", "count("]);
      // The consumer has already read its whole old entitlement before reaching this count.
      await save(a, changed, past, 1, "enterprise");
      expect(await getMembershipReadingForUser(a.id)).toMatchObject({ effectiveTier: "base", limits: getMembershipLimits("base"), storageBytes: getMembershipLimits("base").storage_bytes });
      release(); await holding;
      await expect(pending).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("20") });
      await expect(createProject(a)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("10") });
      expect(await suite.sql`select id from projects where studio_id=${a.studioId} and deleted_at is null`).toHaveLength(25);
      expect(await getLimitsForStudio(a.studioId)).toEqual(getMembershipLimits("base"));
    } finally { release(); await holding; await Promise.allSettled([pending]); await gate.end({ timeout: 1 }); }
  });

  it("uses the current admin for project additions and storage", async () => {
    const a = await account(); const next = await account(); await save(a, { ...negotiated, projects_per_studio: 20 }); await save(next, { ...negotiated, projects_per_studio: 0 }, past);
    await suite.sql`update studios set type='team' where id=${a.studioId}`;
    const source = await seedProject(a); await bytes(a, getMembershipLimits("base").storage_bytes);
    await expect(assertStorageAllowance(source, "upload")).resolves.toBeUndefined();
    await transfer(a, next);
    await expect(assertStorageAllowance(source, "generate")).rejects.toMatchObject({ statusCode: 507 });
    for (let n = 1; n < 10; n++) await seedProject(a);
    await expect(createProject(a)).rejects.toMatchObject({ statusCode: 409 });
    expect(await getLimitsForStudio(a.studioId)).toEqual(getMembershipLimits("base"));
  });

  it("uses the saved Studio member ceiling at invitation and acceptance, then rechecks expiry", async () => {
    const a = await account(); await suite.sql`update studios set type='team' where id=${a.studioId}`; await save(a, { ...negotiated, studio_members: 3 });
    const first = await account("base"); const second = await account("base");
    const one = await studioInvites.createInvite(a.slug, a.id, first.email, "guest");
    await expect(studioInvites.confirmInvite(one.invitationId, first.id)).resolves.toBeUndefined();
    const two = await studioInvites.createInvite(a.slug, a.id, second.email, "guest");
    await save(a, { ...negotiated, studio_members: 999 }, past, 1, "enterprise");
    await expect(studioInvites.confirmInvite(two.invitationId, second.id)).rejects.toMatchObject({ statusCode: 409 });
    const third = await account("base");
    await expect(studioInvites.createInvite(a.slug, a.id, third.email, "guest")).rejects.toMatchObject({ statusCode: 409 });
    expect(await suite.sql`select user_id from studio_members where studio_id=${a.studioId} and deleted_at is null`).toHaveLength(2);
  });

  it("uses the saved project collaborator ceiling at invitation and acceptance and rechecks a tighter saved record", async () => {
    const a = await account(); await save(a, { ...negotiated, project_members: 2 }); const project = await seedProject(a);
    const first = await account("base"); const second = await account("base");
    const one = await projectInvites.createInvite(project, a.id, first.email, "viewer");
    await expect(projectInvites.confirmInvite(one.invitationId, first.id)).resolves.toBeUndefined();
    const two = await projectInvites.createInvite(project, a.id, second.email, "viewer");
    await save(a, { ...negotiated, project_members: 1 }, future, 1, "enterprise");
    await expect(projectInvites.confirmInvite(two.invitationId, second.id)).rejects.toMatchObject({ statusCode: 409 });
    const third = await account("base");
    await expect(projectInvites.createInvite(project, a.id, third.email, "viewer")).rejects.toMatchObject({ statusCode: 409 });
    expect(await suite.sql`select user_id from project_members where project_id=${project} and added_by is not null and deleted_at is null`).toHaveLength(1);
  });

  it("takes Studio and project invitation ceilings from the new admin", async () => {
    const a = await account(); const next = await account();
    await suite.sql`update studios set type='team' where id=${a.studioId}`;
    await save(a, { ...negotiated, studio_members: 9, project_members: 9 });
    await save(next, { ...negotiated, studio_members: 1, project_members: 0 });
    const project = await seedProject(a); await transfer(a, next);
    const invitee = await account("base");
    await expect(studioInvites.createInvite(a.slug, next.id, invitee.email, "guest")).rejects.toMatchObject({ statusCode: 409 });
    await expect(projectInvites.createInvite(project, a.id, invitee.email, "viewer")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps effective enterprise storage exempt despite saved storage=1, then refuses both write purposes after expiry", async () => {
    const a = await account(); await save(a); const project = await seedProject(a); await bytes(a, getMembershipLimits("base").storage_bytes);
    await expect(assertStorageAllowance(project, "upload")).resolves.toBeUndefined();
    await expect(assertStorageAllowance(project, "generate")).resolves.toBeUndefined();
    expect(await readAccountMembership(a.id)).toMatchObject({ tier: "enterprise", limits: null, usage: { storageBytes: getMembershipLimits("base").storage_bytes } });
    await save(a, negotiated, past, 1, "enterprise");
    await expect(assertStorageAllowance(project, "upload")).rejects.toMatchObject({ statusCode: 507 });
    await expect(assertStorageAllowance(project, "generate")).rejects.toMatchObject({ statusCode: 507 });
    expect(await readAccountMembership(a.id)).toMatchObject({ tier: "base", limits: getMembershipLimits("base") });
  });

  it("restores actual paid facts after enterprise expiry and keeps the ordinary manual pro rule", async () => {
    const a = await account(); expect(await readAccountMembership(a.id)).toMatchObject({ tier: "pro", limits: getMembershipLimits("pro") });
    await expect(studioService.createTeamStudio(a.id, "Manual pro", randomUUID())).resolves.toMatchObject({ type: "team" });
    await save(a, negotiated, past);
    await suite.sql`insert into subscriptions(user_id,stripe_subscription_id,tier,period,status,current_period_end,cancel_at_period_end) values(${a.id},${`sub_${randomUUID()}`},'team','month','active',${future},false)`;
    expect(await readAccountMembership(a.id)).toMatchObject({ tier: "team", limits: getMembershipLimits("team") });
    await expect(studioService.createTeamStudio(a.id, "Actual paid", randomUUID())).resolves.toMatchObject({ type: "team" });
  });

  it("preserves self_hosted origin after expiry through display, Studio creation and storage", async () => {
    const a = await account("self_hosted"); await save(a, { ...negotiated, team_studios: 0 }, past, null, "self_hosted");
    const project = await seedProject(a); await bytes(a, getMembershipLimits("base").storage_bytes);
    expect(await readAccountMembership(a.id)).toMatchObject({ tier: "self_hosted", limits: getMembershipLimits("self_hosted") });
    await expect(studioService.createTeamStudio(a.id, "Self hosted", randomUUID())).resolves.toMatchObject({ type: "team" });
    await expect(assertStorageAllowance(project, "upload")).resolves.toBeUndefined();
  });

  it("retains legacy display and storage while refusing unresolved quotas, then consumes completed information", async () => {
    const a = await account("enterprise"); const project = await seedProject(a); await bytes(a, getMembershipLimits("base").storage_bytes);
    expect(await readAccountMembership(a.id)).toMatchObject({ tier: "enterprise", limits: null });
    await expect(assertStorageAllowance(project, "upload")).resolves.toBeUndefined();
    await expect(createProject(a)).rejects.toThrow(/enterprise/i);
    await expect(studioService.createTeamStudio(a.id, "Legacy", randomUUID())).rejects.toThrow(/enterprise/i);
    await save(a, negotiated, future, null, "enterprise");
    await expect(createProject(a)).resolves.toMatchObject({ studioId: a.studioId });
  });
});
