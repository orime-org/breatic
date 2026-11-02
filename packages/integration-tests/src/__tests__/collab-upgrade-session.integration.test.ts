// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { IncomingMessage, MessageType, OutgoingMessage, Server } from "@hocuspocus/server";
import {
  getCollabRedis,
  getProjectConcurrentEditorLimit,
  getRedis,
  getSession,
  initCore,
  loadLocales,
  sessionCookieName,
} from "@breatic/core";
import { projectMetaDocName } from "@breatic/shared";
import { createSession, logout } from "@server/modules/auth/auth.service.js";
import { createAuthHook } from "@collab/hooks/auth.js";
import { createConnectionRegistry } from "@collab/services/connection-registry.js";
import { createUpgradeSessionGate } from "@collab/infra/upgrade-session-gate.js";

/** An actual protocol response, decoded by the installed server library. */
interface Reply {
  documentName: string;
  type: number;
  subtype: number;
  text: string | null;
}

/** A real browser-equivalent connection and the protocol messages it received. */
interface Client {
  socket: WebSocket;
  replies: Reply[];
}

/** The private framework state inspected at the queue allocation boundary. */
interface ClientState {
  incomingMessageQueue: Record<string, Uint8Array[]>;
  incomingMessageQueueBytes: Record<string, number>;
  hookPayloads: Record<string, unknown>;
  documentConnectionsEstablished: Set<string>;
  documentConnections: Record<string, unknown>;
}

/** Test-owned records providing actual PG membership and server-issued sessions. */
interface ProjectFixture {
  projectId: string;
  otherProjectId: string;
  studioId: string;
  ownerId: string;
  viewerId: string;
  strangerId: string;
  ownerToken: string;
  viewerToken: string;
  strangerToken: string;
  spaceIds: [string, string];
}

/** The server and direct hold that keep the fixture's authoritative meta loaded. */
interface Running {
  server: Server;
  gate: ReturnType<typeof createUpgradeSessionGate>;
  disconnectMeta: () => Promise<void>;
  states: ClientState[];
}

let sql: ReturnType<typeof postgres>;
const fixtures: ProjectFixture[] = [];
const servers: Running[] = [];
const clients: Client[] = [];

beforeAll(() => {
  initCore(process.env);
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "collab-upgrade-session-cross-service" },
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.terminate();
  for (const active of servers.splice(0)) {
    active.gate.stop();
    await active.disconnectMeta();
    await active.server.destroy();
  }
  for (const fixture of fixtures.splice(0)) {
    for (const token of [fixture.ownerToken, fixture.viewerToken, fixture.strangerToken]) await logout(token);
    await sql`UPDATE project_members SET deleted_at = NOW()
      WHERE project_id IN (${fixture.projectId}, ${fixture.otherProjectId})`;
    await sql`UPDATE projects SET deleted_at = NOW()
      WHERE id IN (${fixture.projectId}, ${fixture.otherProjectId})`;
    await sql`UPDATE studio_members SET deleted_at = NOW() WHERE studio_id = ${fixture.studioId}`;
    await sql`UPDATE studios SET deleted_at = NOW() WHERE id = ${fixture.studioId}`;
    await sql`UPDATE users SET deleted_at = NOW()
      WHERE id IN (${fixture.ownerId}, ${fixture.viewerId}, ${fixture.strangerId})`;
  }
  vi.restoreAllMocks();
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/**
 * Create isolated real users, Project memberships and API service sessions.
 * @returns The records owned by this test.
 * @throws {Error} When PostgreSQL or Redis rejects fixture creation.
 */
async function projectFixture(): Promise<ProjectFixture> {
  const tag = randomUUID().replaceAll("-", "");
  const users = await sql<{ id: string; email: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`upgrade-owner-${tag}@example.test`}, true),
      (${`upgrade-viewer-${tag}@example.test`}, true),
      (${`upgrade-stranger-${tag}@example.test`}, true)
    RETURNING id, email
  `;
  const ownerId = users.find((user) => user.email.includes("upgrade-owner-"))!.id;
  const viewerId = users.find((user) => user.email.includes("upgrade-viewer-"))!.id;
  const strangerId = users.find((user) => user.email.includes("upgrade-stranger-"))!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${ownerId}, ${`upgrade-${tag}`}, 'personal', 'Session admission') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${ownerId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${ownerId}, 'Session project', ${`session-${tag}`}) RETURNING id
  `;
  const [otherProject] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${strangerId}, 'Other project', ${`other-${tag}`}) RETURNING id
  `;
  const projectId = project!.id;
  const otherProjectId = otherProject!.id;
  await sql`INSERT INTO project_members (project_id, user_id, role)
    VALUES (${projectId}, ${ownerId}, 'owner'), (${projectId}, ${viewerId}, 'viewer'),
      (${otherProjectId}, ${strangerId}, 'owner')`;
  const fixture: ProjectFixture = {
    projectId, otherProjectId, studioId, ownerId, viewerId, strangerId,
    ownerToken: await createSession(ownerId),
    viewerToken: await createSession(viewerId),
    strangerToken: await createSession(strangerId),
    spaceIds: [randomUUID(), randomUUID()],
  };
  fixtures.push(fixture);
  return fixture;
}

/**
 * Start native transport with the production session gate and document auth.
 * @param fixture - The actual Project memberships and declared Spaces.
 * @param timeout - The existing native unauthenticated socket deadline used by this fixture.
 * @returns The listening server with independently observed native allocations.
 * @throws {Error} When transport or the meta fixture cannot start.
 */
async function start(fixture: ProjectFixture, timeout = 10_000): Promise<Running> {
  const redis = getRedis();
  const gate = createUpgradeSessionGate({ redis });
  const registry = createConnectionRegistry({
    redis: getCollabRedis(),
    instanceId: `upgrade-fixture-${randomUUID()}`,
    pingIntervalMs: 30_000,
    seatExpiryMs: 60_000,
  });
  const authenticate = createAuthHook({
    redis,
    resolveConnectionLimit: getProjectConcurrentEditorLimit,
    countConnections: (documentName) => registry.count(documentName),
    hasOwnSeat: (documentName, userId) => registry.hasOwnSeat(documentName, userId),
  });
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    timeout,
    debounce: 0,
    maxDebounce: 0,
    extensions: [gate],
    onAuthenticate: authenticate,
    onLoadDocument: async ({ documentName, document }): Promise<void> => {
      if (documentName === projectMetaDocName(fixture.projectId)) {
        const spaces = document.getMap("spaces");
        for (const id of fixture.spaceIds) {
          const space = new Y.Map();
          spaces.set(id, space);
          space.set("id", id);
          space.set("type", "canvas");
        }
      }
    },
  });
  const states: ClientState[] = [];
  const original = server.hocuspocus.handleConnection.bind(server.hocuspocus);
  vi.spyOn(server.hocuspocus, "handleConnection").mockImplementation((...args) => {
    const connection = original(...args);
    states.push(connection as unknown as ClientState);
    return connection;
  });
  await server.listen();
  const meta = await server.hocuspocus.openDirectConnection(projectMetaDocName(fixture.projectId));
  const active: Running = {
    server, gate, states,
    disconnectMeta: async (): Promise<void> => { await meta.disconnect(); },
  };
  servers.push(active);
  return active;
}

/**
 * Open a real WebSocket using the API service's httpOnly-session credential.
 * @param active - The native transport server.
 * @param token - The actual server-issued session.
 * @returns The authenticated-upgrade client and its decoded replies.
 * @throws {Error} When the HTTP upgrade is rejected or the transport fails.
 */
async function open(active: Running, token: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${active.server.address.port}/`, {
    headers: { cookie: `${sessionCookieName()}=${token}` },
  });
  const client: Client = { socket, replies: [] };
  clients.push(client);
  socket.on("message", (data) => {
    const message = new IncomingMessage(data);
    const documentName = message.readVarString();
    const type = message.readVarUint();
    if (type !== MessageType.Auth && type !== MessageType.SyncStatus) return;
    const subtype = message.readVarUint();
    client.replies.push({
      documentName, type, subtype,
      text: type === MessageType.Auth && (subtype === 1 || subtype === 2) ? message.readVarString() : null,
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Expected HTTP 101, received ${response.statusCode}`));
    });
  });
  return client;
}

/**
 * Send a document authentication frame using the installed lib0 encoder.
 * @param client - The upgraded physical connection.
 * @param documentName - The document to authenticate now.
 */
function authenticateDocument(client: Client, documentName: string): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, documentName);
  encoding.writeVarUint(encoder, MessageType.Auth);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarString(encoder, "__cookie_auth__");
  client.socket.send(encoding.toUint8Array(encoder));
}

/**
 * Wait for a specific auth response sent by the actual server.
 * @param client - The response observer.
 * @param documentName - The addressed document.
 * @param subtype - Authenticated (2) or permission-denied (1).
 * @returns The matching protocol response.
 * @throws {Error} When the response does not arrive.
 */
async function authReply(client: Client, documentName: string, subtype: number): Promise<Reply> {
  await expect.poll(() => client.replies.filter((reply) =>
    reply.documentName === documentName && reply.type === MessageType.Auth && reply.subtype === subtype,
  ).length, { timeout: 5_000 }).toBe(1);
  return client.replies.find((reply) =>
    reply.documentName === documentName && reply.type === MessageType.Auth && reply.subtype === subtype,
  )!;
}

/**
 * Write a unique value through an actual Yjs sync frame.
 * @param client - The physical client trying the write.
 * @param documentName - The target document.
 * @param value - The unique test value.
 * @param key - A distinct field for a rejected write to make any applied update observable.
 */
function writeContent(client: Client, documentName: string, value: string, key = "value"): void {
  const document = new Y.Doc();
  document.getMap("content").set(key, value);
  const update = Y.encodeStateAsUpdate(document);
  document.destroy();
  client.socket.send(new OutgoingMessage(documentName).createSyncMessage().writeUpdate(update).toUint8Array());
}

describe("server session lifecycle and collab upgrade/document authorization", () => {
  it("rejects document Auth after the server revokes a session following HTTP 101", async () => {
    const fixture = await projectFixture();
    const active = await start(fixture, 200);
    const client = await open(active, fixture.ownerToken);
    expect(active.states).toHaveLength(1);
    const documentName = `project-${fixture.projectId}/canvas-${fixture.spaceIds[0]}`;
    writeContent(client, documentName, "queued-before-revocation");
    await expect.poll(() => active.states[0]?.incomingMessageQueue[documentName]?.length).toBe(1);
    await logout(fixture.ownerToken);
    expect(await getSession(getRedis(), fixture.ownerToken)).toBe(null);
    authenticateDocument(client, documentName);
    expect((await authReply(client, documentName, 1)).text).toBe("permission-denied");
    const state = active.states[0]!;
    expect(Object.keys(state.hookPayloads)).toEqual([]);
    expect(Object.keys(state.incomingMessageQueue)).toEqual([]);
    expect(Object.keys(state.incomingMessageQueueBytes)).toEqual([]);
    expect([...state.documentConnectionsEstablished]).toEqual([]);
    expect(Object.keys(state.documentConnections)).toEqual([]);
    await expect.poll(() => client.socket.readyState, { timeout: 5_000 }).toBe(WebSocket.CLOSED);
  });

  it("keeps actual Project membership and cross-Project isolation after valid session upgrade", async () => {
    const fixture = await projectFixture();
    const active = await start(fixture);
    const owner = await open(active, fixture.ownerToken);
    const stranger = await open(active, fixture.strangerToken);
    const ownMeta = projectMetaDocName(fixture.projectId);
    const foreignMeta = projectMetaDocName(fixture.otherProjectId);
    authenticateDocument(owner, ownMeta);
    expect((await authReply(owner, ownMeta, 2)).text).toBe("readonly");
    authenticateDocument(owner, foreignMeta);
    expect((await authReply(owner, foreignMeta, 1)).text).toBe("permission-denied");
    authenticateDocument(stranger, ownMeta);
    expect((await authReply(stranger, ownMeta, 1)).text).toBe("permission-denied");
    expect(active.states).toHaveLength(2);
    expect(Object.keys(active.states[1]!.documentConnections)).toEqual([]);
  });

  it("keeps Viewer and meta writes read-only while an owner can write both Space documents", async () => {
    const fixture = await projectFixture();
    const active = await start(fixture);
    const owner = await open(active, fixture.ownerToken);
    const viewer = await open(active, fixture.viewerToken);
    const metaName = projectMetaDocName(fixture.projectId);
    const names = fixture.spaceIds.map((id) => `project-${fixture.projectId}/canvas-${id}`);
    authenticateDocument(owner, metaName);
    expect((await authReply(owner, metaName, 2)).text).toBe("readonly");
    for (const documentName of names) {
      authenticateDocument(owner, documentName);
      authenticateDocument(viewer, documentName);
      expect((await authReply(owner, documentName, 2)).text).toBe("read-write");
      expect((await authReply(viewer, documentName, 2)).text).toBe("readonly");
      await expect.poll(() => active.server.hocuspocus.documents.get(documentName)?.getConnectionsCount()).toBe(2);
      writeContent(owner, documentName, `owner-${documentName}`);
      await expect.poll(() => active.server.hocuspocus.documents.get(documentName)?.getMap("content").get("value"))
        .toBe(`owner-${documentName}`);
      writeContent(viewer, documentName, `viewer-${documentName}`, "viewer-attempt");
      await expect.poll(() => viewer.replies.filter((reply) =>
        reply.documentName === documentName && reply.type === MessageType.SyncStatus && reply.subtype === 0,
      ).length).toBe(1);
      expect(active.server.hocuspocus.documents.get(documentName)?.getMap("content").toJSON())
        .toEqual({ value: `owner-${documentName}` });
    }
    writeContent(owner, metaName, "client-meta-write");
    await expect.poll(() => owner.replies.filter((reply) =>
      reply.documentName === metaName && reply.type === MessageType.SyncStatus && reply.subtype === 0,
    ).length).toBe(1);
    expect(active.server.hocuspocus.documents.get(metaName)?.getMap("content").toJSON()).toEqual({});
  });
});
