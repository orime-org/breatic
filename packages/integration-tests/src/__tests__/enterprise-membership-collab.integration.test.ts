// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import WebSocket from "ws";
import * as Y from "yjs";
import { Server } from "@hocuspocus/server";
import {
  getCollabRedis,
  getMembershipLimits,
  getProjectConcurrentEditorLimit,
  getRedis,
  initCore,
  loadLocales,
  sessionCookieName,
  type EnterpriseMembershipWrite,
} from "@breatic/core";
import { projectMetaDocName, type MembershipTier } from "@breatic/shared";
import { createSession, logout } from "@server/modules/auth/auth.service.js";
import { save } from "@server/modules/enterprise-membership/enterprise-membership.service.js";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";
import { createAuthHook, type AuthContext } from "@collab/hooks/auth.js";
import { createUpgradeSessionGate } from "@collab/infra/upgrade-session-gate.js";
import { createConnectionRegistry, type ConnectionRegistry } from "@collab/services/connection-registry.js";
import { shouldTrackConnection } from "@collab/services/connection-tracking.js";
import { getConnectionTimings } from "@collab/config.js";
import {
  authFrame,
  decodeServerFrame,
  syncFrame,
  SYNC,
  WIRE,
  type ServerFrame,
} from "@collab/__tests__/helpers/live-hocuspocus.js";

/** Records owned by one case, including real API-issued Redis sessions. */
interface Fixture {
  userIds: string[];
  tokens: string[];
  studioId: string;
  projectId: string;
  spaceId: string;
}

/** A native TCP/WebSocket client, with protocol replies and a receiving Y.Doc. */
interface Client {
  socket: WebSocket;
  replies: ServerFrame[];
  document: Y.Doc;
  documentName: string;
}

/** Production authorization and seat infrastructure on a native listener. */
interface Running {
  server: Server;
  registry: ConnectionRegistry;
  /** What every `takeSeat` the `connected` hook ran answered, in order. */
  takes: string[];
  /** What every `hasOwnSeat` the handshake asked answered, in order. */
  owns: string[];
  gate: ReturnType<typeof createUpgradeSessionGate>;
  disconnectMeta: () => Promise<void>;
}

let sql: ReturnType<typeof postgres>;
const fixtures: Fixture[] = [];
const servers: Running[] = [];
const clients: Client[] = [];

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 1,
    prepare: false,
    connection: { application_name: "enterprise-membership-collab-consumer" },
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.socket.once("close", resolve);
        client.socket.terminate();
      });
    }
    client.document.destroy();
  }
  for (const active of servers.splice(0)) {
    active.gate.stop();
    await active.disconnectMeta();
    await active.server.destroy();
  }
  for (const fixture of fixtures.splice(0)) {
    for (const token of fixture.tokens) await logout(token);
    await sql`UPDATE project_members SET deleted_at = NOW() WHERE project_id = ${fixture.projectId}`;
    await sql`UPDATE projects SET deleted_at = NOW() WHERE id = ${fixture.projectId}`;
    await sql`UPDATE studio_members SET deleted_at = NOW() WHERE studio_id = ${fixture.studioId}`;
    await sql`UPDATE studios SET deleted_at = NOW() WHERE id = ${fixture.studioId}`;
    await sql`UPDATE enterprise_memberships SET deleted_at = NOW() WHERE user_id IN ${sql(fixture.userIds)}`;
    await sql`UPDATE users SET deleted_at = NOW() WHERE id IN ${sql(fixture.userIds)}`;
  }
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Create real Studio and Project memberships using the enterprise save service.
 * @param tier - The first administrator's stored tier before any enterprise save.
 * @param memberCount - Distinct identities prevent own-seat handover masking a full document.
 * @returns The isolated records and sessions for this case.
 * @throws {Error} When fixture persistence or session creation fails.
 */
async function createFixture(tier: MembershipTier = "base", memberCount = 4): Promise<Fixture> {
  const fixture: Fixture = {
    userIds: Array.from({ length: memberCount }, () => randomUUID()),
    tokens: [],
    studioId: randomUUID(),
    projectId: randomUUID(),
    spaceId: randomUUID(),
  };
  fixtures.push(fixture);
  for (const [index, userId] of fixture.userIds.entries()) {
    await sql`INSERT INTO users (id, email, email_verified, membership_tier)
      VALUES (${userId}, ${`enterprise-collab-${userId}@example.test`}, true, ${index === 0 ? tier : "base"})`;
    fixture.tokens.push(await createSession(userId));
  }
  const ownerId = fixture.userIds[0]!;
  await sql`INSERT INTO studios (id, created_by_user_id, slug, type, name)
    VALUES (${fixture.studioId}, ${ownerId}, ${`ec-${fixture.studioId.replaceAll("-", "")}`}, 'team', 'Enterprise collaboration')`;
  await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
    VALUES (${fixture.projectId}, ${fixture.studioId}, ${ownerId}, 'Enterprise Project', ${`enterprise-${fixture.projectId}`})`;
  for (const [index, userId] of fixture.userIds.entries()) {
    await sql`INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${fixture.studioId}, ${userId}, ${index === 0 ? "admin" : "maintainer"})`;
    await sql`INSERT INTO project_members (project_id, user_id, role)
      VALUES (${fixture.projectId}, ${userId}, ${index === 0 ? "owner" : "editor"})`;
  }
  return fixture;
}

/**
 * Persist negotiated data through the actual management service and transaction.
 * @param userId - The administrator who owns the negotiated membership.
 * @param concurrentEditors - The negotiated writable connection ceiling.
 * @param options - Initial stored tier, expected revision and requested expiry state.
 * @returns After the save is confirmed applied with its expected revision.
 * @throws {Error} When the database or the management service fails.
 */
async function saveEnterprise(
  userId: string,
  concurrentEditors: number,
  options: { storedTier?: MembershipTier; revision?: number; expired?: boolean } = {},
): Promise<void> {
  const body: EnterpriseMembershipWrite = {
    targetTier: "enterprise",
    expiresAt: new Date(Date.now() + (options.expired ? -86_400_000 : 86_400_000)).toISOString(),
    entryTimezone: "UTC",
    contractNumber: `collab-${randomUUID()}`,
    limits: {
      team_studios: 5,
      projects_per_studio: 20,
      concurrent_editors: concurrentEditors,
      studio_members: 20,
      project_members: 20,
      storage_bytes: 0,
    },
    expectedRevision: options.revision ?? null,
    expectedStoredTier: options.storedTier ?? "base",
  };
  const result = await save({
    userId,
    key: `bo-${randomUUID()}`,
    hash: fingerprint("POST", "/internal/v1/accounts/:userId/enterprise-membership", userId, body),
    adminId: "collab-consumer-admin",
    body,
  });
  expect(result.status).toBe(200);
  if (result.status !== 200) throw new Error("Membership save did not return its original result");
  expect(result.body.status).toBe("applied");
  expect(result.body.after?.enterprise?.revision).toBe((options.revision ?? 0) + 1);
}

/**
 * Start the same native transport, auth lookup and Redis seat lifecycle as production.
 * Only document loading is fixture-owned; authorization and quota reads remain real.
 * @param fixture - The existing Project, Space and authenticated identities.
 * @returns A native WebSocket listener and the real seat registry it uses.
 * @throws {Error} When transport or the pinned metadata document cannot start.
 */
async function start(fixture: Fixture): Promise<Running> {
  const gate = createUpgradeSessionGate({ redis: getRedis() });
  const timings = getConnectionTimings();
  const registry = createConnectionRegistry({
    redis: getCollabRedis(),
    instanceId: `enterprise-fixture-${randomUUID()}`,
    pingIntervalMs: timings.pingIntervalMs,
    seatExpiryMs: timings.seatExpiryMs,
  });
  const takes: string[] = [];
  const owns: string[] = [];
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    debounce: 0,
    maxDebounce: 0,
    extensions: [gate],
    onAuthenticate: createAuthHook({
      redis: getRedis(),
      resolveConnectionLimit: getProjectConcurrentEditorLimit,
      countConnections: (documentName) => registry.count(documentName),
      hasOwnSeat: async (documentName, userId) => {
        const own = await registry.hasOwnSeat(documentName, userId);
        owns.push(own);
        return own;
      },
    }),
    onLoadDocument: async ({ documentName, document }): Promise<void> => {
      if (documentName === projectMetaDocName(fixture.projectId)) {
        const space = new Y.Map();
        document.getMap("spaces").set(fixture.spaceId, space);
        space.set("id", fixture.spaceId);
        space.set("type", "canvas");
      } else {
        document.getMap("content").set("preserved", "existing-content");
      }
    },
    // The production `connected` hook's seat step: the handshake hands over
    // the ceiling it judged by (null when this connection takes no seat) and
    // the moment it started, and the seat is taken atomically here.
    connected: async ({ documentName, socketId, context }): Promise<void> => {
      const auth = context as AuthContext;
      if (auth.seatCap === null) return;
      const result = await registry.takeSeat(
        documentName,
        { socketId, userId: auth.user.id, arrivedAtMs: auth.arrivedAtMs },
        auth.seatCap,
      );
      takes.push(result.outcome);
    },
    onDisconnect: async ({ documentName, socketId }): Promise<void> => {
      if (shouldTrackConnection(documentName)) await registry.unregister(documentName, socketId);
    },
  });
  // Register ownership before starting so a failed listen is still cleaned up.
  const active: Running = { server, registry, takes, owns, gate, disconnectMeta: async (): Promise<void> => {} };
  servers.push(active);
  await server.listen();
  const meta = await server.hocuspocus.openDirectConnection(projectMetaDocName(fixture.projectId));
  active.disconnectMeta = async (): Promise<void> => { await meta.disconnect(); };
  return active;
}

/**
 * Authenticate a fresh physical WebSocket and its Space with a server-issued cookie.
 * @param active - The real native transport.
 * @param fixture - The owned Project and Space.
 * @param index - The distinct authenticated Project member.
 * @param mode - The required wire-level auth result.
 * @returns A real socket and its synchronized receiving document.
 * @throws {Error} When upgrade, authentication or initial synchronization fails.
 */
async function connect(
  active: Running,
  fixture: Fixture,
  index: number,
  mode: "read-write" | "readonly",
): Promise<Client> {
  const documentName = `project-${fixture.projectId}/canvas-${fixture.spaceId}`;
  const socket = new WebSocket(`ws://127.0.0.1:${active.server.address.port}/`, {
    headers: { cookie: `${sessionCookieName()}=${fixture.tokens[index]!}` },
  });
  const client: Client = { socket, replies: [], document: new Y.Doc(), documentName };
  clients.push(client);
  socket.on("message", (data) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const frame = decodeServerFrame(bytes);
    client.replies.push(frame);
    if (frame.docName === documentName && frame.update) Y.applyUpdate(client.document, frame.update);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Expected HTTP 101, received ${response.statusCode}`));
    });
  });
  socket.send(authFrame(documentName, "__cookie_auth__"));
  await expect.poll(() => client.replies.filter((frame) => frame.authSubType === 2).map((frame) => frame.authDetail))
    .toEqual([mode]);
  socket.send(syncFrame(documentName, WIRE.sync, SYNC.step1, Y.encodeStateVector(client.document)));
  await expect.poll(() => client.document.getMap("content").get("preserved")).toBe("existing-content");
  return client;
}

/**
 * Wait for the real connected lifecycle hook before the next seat is checked.
 * @param active - The transport's actual Redis registry.
 * @param fixture - The content document whose seats are counted.
 * @param expected - The exact number of writable identities admitted so far.
 * @returns Once the production registry records every admitted writable seat.
 * @throws {Error} When the expected registration does not happen.
 */
async function seats(active: Running, fixture: Fixture, expected: number): Promise<void> {
  await expect.poll(() => active.registry.count(`project-${fixture.projectId}/canvas-${fixture.spaceId}`)).toBe(expected);
}

/**
 * Write over the actual Yjs wire and assert the protocol enforcement result.
 * @param active - The authoritative in-memory document holder.
 * @param client - A physical socket whose authorization is under test.
 * @param key - A unique field so ignored writes cannot hide an earlier update.
 * @param allowed - Whether the original handshake granted this connection writes.
 * @returns After authoritative state, receiving state or refusal is observed.
 * @throws {Error} When the observed protocol behavior differs from its contract.
 */
async function write(active: Running, client: Client, key: string, allowed: boolean): Promise<void> {
  const updateDoc = new Y.Doc();
  updateDoc.getMap("content").set(key, key);
  const update = Y.encodeStateAsUpdate(updateDoc);
  updateDoc.destroy();
  const before = client.replies.filter((frame) => frame.type === WIRE.syncStatus && !frame.syncStatusOk).length;
  client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, update));
  if (allowed) {
    await expect.poll(() => active.server.hocuspocus.documents.get(client.documentName)?.getMap("content").get(key)).toBe(key);
    await expect.poll(() => client.document.getMap("content").get(key)).toBe(key);
  } else {
    await expect.poll(() => client.replies.filter((frame) => frame.type === WIRE.syncStatus && !frame.syncStatusOk).length)
      .toBe(before + 1);
    expect(active.server.hocuspocus.documents.get(client.documentName)?.getMap("content").has(key)).toBe(false);
    expect(client.document.getMap("content").has(key)).toBe(false);
  }
}

describe("persisted enterprise membership in real collab handshakes", () => {
  it("applies the saved negotiated cap and its revision to fresh sockets preserving existing connections", async () => {
    const fixture = await createFixture();
    await saveEnterprise(fixture.userIds[0]!, 1);
    const active = await start(fixture);
    const first = await connect(active, fixture, 0, "read-write");
    await seats(active, fixture, 1);
    const overCap = await connect(active, fixture, 1, "readonly");
    await write(active, overCap, "blocked-at-one", false);
    await saveEnterprise(fixture.userIds[0]!, 2, { storedTier: "enterprise", revision: 1 });
    const next = await connect(active, fixture, 2, "read-write");
    await seats(active, fixture, 2);
    await write(active, next, "new-seat-after-save", true);
    await write(active, first, "old-seat-after-save", true);
    await write(active, overCap, "old-readonly-after-save", false);
    const fullAgain = await connect(active, fixture, 3, "readonly");
    await write(active, fullAgain, "blocked-at-two", false);
    await seats(active, fixture, 2);
    // Only the two writable handshakes took a seat, and both got one; each
    // read-only handshake was a full document asking about a seat its
    // distinct user never held.
    expect(active.takes).toEqual(["seated", "seated"]);
    expect(active.owns).toEqual(["no", "no"]);
  });

  it("uses ordinary base seats after saved SaaS expiry while old writable connections and content remain", async () => {
    const baseCap = getMembershipLimits("base").concurrent_editors;
    const fixture = await createFixture("base", baseCap + 2);
    await saveEnterprise(fixture.userIds[0]!, baseCap + 1);
    const active = await start(fixture);
    const existing: Client[] = [];
    for (let index = 0; index <= baseCap; index++) {
      existing.push(await connect(active, fixture, index, "read-write"));
      await seats(active, fixture, index + 1);
    }
    await write(active, existing[0]!, "before-expiry", true);
    await saveEnterprise(fixture.userIds[0]!, 999, { storedTier: "enterprise", revision: 1, expired: true });
    const afterExpiry = await connect(active, fixture, baseCap + 1, "readonly");
    expect(afterExpiry.document.getMap("content").get("before-expiry")).toBe("before-expiry");
    await write(active, afterExpiry, "expired-new-seat", false);
    await write(active, existing[0]!, "old-seat-after-expiry", true);
    await expect.poll(() => afterExpiry.document.getMap("content").get("old-seat-after-expiry"))
      .toBe("old-seat-after-expiry");
    await seats(active, fixture, baseCap + 1);
    expect(active.takes).toEqual(Array.from({ length: baseCap + 1 }, () => "seated"));
    expect(active.owns).toEqual(["no"]);
  });

  it("preserves self-hosted provenance on expiry and grants its configured seats", async () => {
    const baseCap = getMembershipLimits("base").concurrent_editors;
    const fixture = await createFixture("self_hosted", baseCap + 1);
    await saveEnterprise(fixture.userIds[0]!, 0, { storedTier: "self_hosted", expired: true });
    const active = await start(fixture);
    for (let index = 0; index <= baseCap; index++) {
      const client = await connect(active, fixture, index, "read-write");
      await seats(active, fixture, index + 1);
      await write(active, client, `self-hosted-seat-${index}`, true);
    }
    expect(active.takes).toEqual(Array.from({ length: baseCap + 1 }, () => "seated"));
  });

  it("keeps legacy enterprise content readable while unresolved negotiated limits refuse new writes", async () => {
    const fixture = await createFixture("enterprise");
    const active = await start(fixture);
    const owner = await connect(active, fixture, 0, "readonly");
    const editor = await connect(active, fixture, 1, "readonly");
    await write(active, owner, "legacy-owner-attempt", false);
    await write(active, editor, "legacy-editor-attempt", false);
    expect(owner.document.getMap("content").toJSON()).toEqual({ preserved: "existing-content" });
    expect(editor.document.getMap("content").toJSON()).toEqual({ preserved: "existing-content" });
    await seats(active, fixture, 0);
    expect(active.takes).toEqual([]);
  });

  it("reads the current Studio administrator on the next handshake and preserves prior connections", async () => {
    const fixture = await createFixture();
    await saveEnterprise(fixture.userIds[0]!, 2);
    await saveEnterprise(fixture.userIds[1]!, 0);
    const active = await start(fixture);
    const previousAdmin = await connect(active, fixture, 0, "read-write");
    await seats(active, fixture, 1);
    await sql.begin(async (tx) => {
      await tx`UPDATE studio_members SET role = 'maintainer' WHERE studio_id = ${fixture.studioId} AND user_id = ${fixture.userIds[0]!}`;
      await tx`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${fixture.studioId} AND user_id = ${fixture.userIds[1]!}`;
    });
    const next = await connect(active, fixture, 2, "readonly");
    await write(active, next, "new-admin-zero-cap", false);
    await write(active, previousAdmin, "previous-admin-existing-seat", true);
    await expect.poll(() => next.document.getMap("content").get("previous-admin-existing-seat"))
      .toBe("previous-admin-existing-seat");
    await seats(active, fixture, 1);
    expect(active.takes).toEqual(["seated"]);
  });

  it("continues honoring a manual ordinary pro tier with no subscription at its configured seat boundary", async () => {
    const cap = getMembershipLimits("pro").concurrent_editors;
    const fixture = await createFixture("pro", cap + 1);
    const active = await start(fixture);
    for (let index = 0; index < cap; index++) {
      await connect(active, fixture, index, "read-write");
      await seats(active, fixture, index + 1);
    }
    const next = await connect(active, fixture, cap, "readonly");
    await write(active, next, "ordinary-pro-over-cap", false);
    await seats(active, fixture, cap);
    expect(active.takes).toEqual(Array.from({ length: cap }, () => "seated"));
    expect(active.owns).toEqual(["no"]);
  });
});
