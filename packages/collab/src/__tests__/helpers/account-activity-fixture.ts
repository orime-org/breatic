// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as Y from "yjs";
import { getRedis, getCollabRedis, getProjectConcurrentEditorLimit, rawPg as sql, setSession, sessionCookieName, writeSpaceEntry } from "@breatic/core";
import { projectMetaDocName, spaceContentDocName } from "@breatic/shared";
import type { SpaceType } from "@breatic/shared";
import { createAuthHook } from "@collab/hooks/auth.js";
import { createConnectionRegistry } from "@collab/services/connection-registry.js";
import { getConnectionTimings } from "@collab/config.js";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import { authFrame, decodeServerFrame, statelessFrame, waitFor } from "./live-hocuspocus.js";
import type { ServerFrame } from "./live-hocuspocus.js";

export interface ActivityCollabFixture {
  userId: string;
  projectId: string;
  spaceIds: Record<SpaceType, string>;
  cookie: string;
}
export interface ActivityClient {
  socket: WebSocket;
  replies: ServerFrame[];
  documentName: string;
  document: Y.Doc;
}

/**
 * Create a real authenticated owner and one persisted Space per content kind.
 * @returns Its Project, session and content identities.
 * @throws {Error} When PG, Yjs persistence or Redis session creation fails.
 */
export async function seedCollabActivity(): Promise<ActivityCollabFixture> {
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const [user] = await sql<{ id: string }[]>`INSERT INTO users(email,email_verified,membership_tier) VALUES(${`ca-${tag}@example.test`},true,'pro') RETURNING id`;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`INSERT INTO studios(created_by_user_id,slug,type,name) VALUES(${userId},${`ca-s-${tag}`},'personal','Activity') RETURNING id`;
  await sql`INSERT INTO studio_members(studio_id,user_id,role) VALUES(${studio!.id},${userId},'admin')`;
  const [project] = await sql<{ id: string }[]>`INSERT INTO projects(studio_id,created_by_user_id,slug,name) VALUES(${studio!.id},${userId},${`ca-p-${tag}`},'Activity') RETURNING id`;
  const projectId = project!.id;
  await sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${projectId},${userId},'owner')`;
  const spaceIds = { canvas: randomUUID(), document: randomUUID(), timeline: randomUUID(), "3d": randomUUID() };
  const meta = new Y.Doc();
  for (const [order, type] of (["canvas", "document", "timeline", "3d"] as const).entries()) {
    writeSpaceEntry(meta.getMap("spaces"), { spaceId: spaceIds[type], type, name: type, order, createdAt: 1, createdBy: userId });
    const content = new Y.Doc();
    content.getMap("activity-test").set("existing", "preserved");
    await yjsRepo.upsertDocData(spaceContentDocName(projectId, spaceIds[type], type), Y.encodeStateAsUpdate(content));
    content.destroy();
  }
  await yjsRepo.upsertDocData(projectMetaDocName(projectId), Y.encodeStateAsUpdate(meta));
  meta.destroy();
  const token = randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, projectId, spaceIds, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * Start real loopback Hocuspocus with production authentication and persistence.
 * @param extra - The production hook or RPC route being tested.
 * @returns The running listener and pinned Project meta connection.
 * @throws {Error} When dependencies or the listener cannot start.
 */
export async function serveCollabActivity(extra: Partial<ConstructorParameters<typeof Server>[0]>): Promise<Server> {
  const timings = getConnectionTimings();
  const registry = createConnectionRegistry({ redis: getCollabRedis(), instanceId: `activity-${randomUUID()}`, pingIntervalMs: timings.pingIntervalMs, seatExpiryMs: timings.seatExpiryMs });
  const server = new Server({
    port: 0, address: "127.0.0.1", quiet: true, stopOnSignals: false,
    onAuthenticate: createAuthHook({ redis: getRedis(), resolveConnectionLimit: getProjectConcurrentEditorLimit,
      countConnections: (name) => registry.count(name), hasOwnSeat: (name, userId) => registry.hasOwnSeat(name, userId) }),
    extensions: [createPersistenceExtension()],
    ...extra,
  });
  await server.listen();
  return server;
}

/**
 * Open and authenticate a native WebSocket with the real Redis-backed session.
 * @param server - Loopback listener.
 * @param fixture - The authenticated account.
 * @param documentName - Actual persisted content or meta document.
 * @param expectedMode - Expected result of production authorization.
 * @returns An authenticated client, decoded frames and its receiving Y.Doc.
 * @throws {Error} When connection or authentication cannot complete.
 */
export async function connectCollabActivity(server: Server, fixture: ActivityCollabFixture, documentName: string, expectedMode: "read-write" | "readonly" = "read-write"): Promise<ActivityClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address.port}/`, { headers: { cookie: fixture.cookie } });
  const client: ActivityClient = { socket, replies: [], documentName, document: new Y.Doc() };
  socket.on("error", () => {});
  socket.on("message", (data) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const frame = decodeServerFrame(bytes);
    client.replies.push(frame);
    if (frame.docName === documentName && frame.update) Y.applyUpdate(client.document, frame.update);
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(authFrame(documentName, "__cookie_auth__"));
  await waitFor(() => client.replies.some((frame) => frame.authSubType === 2 && frame.authDetail === expectedMode), "real activity authentication");
  return client;
}

/**
 * Wait for a same-socket stateless acknowledgement after prior sync messages.
 * @param client - The authenticated native client.
 * @returns Once the listener has handled its barrier.
 * @throws {Error} When the socket cannot receive the barrier reply.
 */
export async function activityBarrier(client: ActivityClient): Promise<void> {
  const marker = `activity-barrier-${randomUUID()}`;
  client.socket.send(statelessFrame(client.documentName, marker));
  await waitFor(() => client.replies.some((frame) => frame.stateless === marker), "activity frame barrier");
}

/**
 * Read this authenticated account's durable metadata without content.
 * @param fixture - Account identity to read.
 * @returns Durable activity rows with exact timestamp text.
 * @throws {Error} When the schema or PG query fails.
 */
export async function collabActivityRows(fixture: ActivityCollabFixture): Promise<Array<{ id: string; user_id: string; project_id: string; kind: string; occurred_at: string }>> {
  return sql`SELECT id,user_id,project_id,kind,occurred_at::text FROM account_activity_events WHERE user_id=${fixture.userId} ORDER BY created_at,id`;
}

/**
 * Install a reversible real PG failure for this account only.
 * @param fixture - The activity writer whose insert must fail.
 * @returns Trigger cleanup.
 * @throws {Error} When PG cannot install or remove the fixture.
 */
export async function rejectCollabActivity(fixture: ActivityCollabFixture): Promise<() => Promise<void>> {
  const fn = `ca_reject_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${fixture.userId}'::uuid THEN RAISE EXCEPTION 'activity fixture append rejected'; END IF; RETURN NEW; END $$`);
  try { await sql.unsafe(`CREATE TRIGGER ${fn}_t BEFORE INSERT ON account_activity_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`); }
  catch (error) { await sql.unsafe(`DROP FUNCTION ${fn}()`); throw error; }
  return async (): Promise<void> => { await sql.unsafe(`DROP TRIGGER ${fn}_t ON account_activity_events`); await sql.unsafe(`DROP FUNCTION ${fn}()`); };
}
