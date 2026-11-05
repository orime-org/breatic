// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "@hocuspocus/server";
import { initCore, loadLocales, rawPg as sql } from "@breatic/core";
import { parseDocName, projectMetaDocName, SpaceRpcRequestSchema } from "@breatic/shared";
import type { SpaceRpcRequest, SpaceRpcResponse } from "@breatic/shared";
import { handleSpaceRpc } from "@collab/services/space-rpc.js";
import type { AuthContext } from "@collab/hooks/auth.js";
import { collabActivityRows, connectCollabActivity, seedCollabActivity, serveCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityClient, ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { statelessFrame, waitFor } from "./helpers/live-hocuspocus.js";

initCore(process.env);
loadLocales();
const servers: Server[] = [];
const clients: ActivityClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) { client.socket.terminate(); client.document.destroy(); }
  for (const server of servers.splice(0)) await server.destroy();
});

type Action = "create" | "delete" | "lock" | "rename" | "restore";

/**
 * Build a validated current Space RPC payload for a persisted fixture Space.
 * @param fixture - Real Project and Space identities.
 * @param action - The existing RPC action.
 * @returns The request with a unique reply identity.
 * @throws {Error} When the test input fails its production schema.
 */
function request(fixture: ActivityCollabFixture, action: Action): SpaceRpcRequest {
  const spaceId = fixture.spaceIds.canvas;
  const payload = action === "create" ? { type: "canvas", name: "Created activity Space", claimToken: randomUUID() }
    : action === "lock" ? { spaceId, locked: true } : action === "rename" ? { spaceId, name: "Renamed activity Space" } : { spaceId };
  return SpaceRpcRequestSchema.parse({ id: randomUUID(), type: `space:${action}`, payload });
}

/**
 * Expose the existing RPC handler on native Hocuspocus, forwarding only its authenticated context.
 * @param fixture - Real authenticated Project owner or viewer.
 * @returns Its meta client, whose document is always read-only on the wire.
 * @throws {Error} When native transport, auth or RPC setup fails.
 */
async function connect(fixture: ActivityCollabFixture): Promise<ActivityClient> {
  const server = await serveCollabActivity({
    onStateless: async ({ documentName, connection, payload }): Promise<void> => {
      const parsed = parseDocName(documentName);
      if (parsed?.kind !== "meta") return;
      const body = SpaceRpcRequestSchema.safeParse(JSON.parse(payload));
      if (!body.success) return;
      const auth = connection.context as AuthContext;
      const result = await handleSpaceRpc({ hocuspocus: server.hocuspocus }, parsed.projectId, { userId: auth.user.id, role: auth.user.role }, body.data);
      connection.sendStateless(JSON.stringify(result));
    },
  });
  servers.push(server);
  const client = await connectCollabActivity(server, fixture, projectMetaDocName(fixture.projectId), "readonly");
  clients.push(client);
  return client;
}

/**
 * Send one real meta stateless request and wait for its own correlated response.
 * @param client - Authenticated native connection.
 * @param body - Validated production RPC request.
 * @returns The actual handler response received over the socket.
 * @throws {Error} When no response arrives.
 */
async function rpc(client: ActivityClient, body: SpaceRpcRequest): Promise<SpaceRpcResponse> {
  client.socket.send(statelessFrame(client.documentName, JSON.stringify(body)));
  let result: SpaceRpcResponse | undefined;
  await waitFor(() => {
    for (const frame of client.replies) {
      if (!frame.stateless) continue;
      const value = JSON.parse(frame.stateless) as SpaceRpcResponse;
      if (value.id === body.id) { result = value; return true; }
    }
    return false;
  }, "correlated real Space RPC response");
  return result!;
}

describe("trusted activity from real Space RPC (inner#1893)", () => {
  for (const action of ["create", "delete", "lock", "rename", "restore"] as const) {
    it(`P12 attributes accepted Space ${action} to its authenticated caller`, async () => {
      const fixture = await seedCollabActivity();
      const client = await connect(fixture);
      if (action === "restore") expect((await rpc(client, request(fixture, "delete"))).ok).toBe(true);
      const response = await rpc(client, request(fixture, action));
      expect(response.ok, JSON.stringify(response)).toBe(true);
      const rows = await collabActivityRows(fixture);
      expect(rows).toHaveLength(action === "restore" ? 2 : 1);
      for (const row of rows) expect(row).toMatchObject({ user_id: fixture.userId, project_id: fixture.projectId, kind: "project_action" });
    });

    it(`P12 leaves no activity after a real viewer's Space ${action} refusal`, async () => {
      const fixture = await seedCollabActivity();
      await sql`UPDATE studio_members SET role='guest' WHERE user_id=${fixture.userId}`;
      await sql`UPDATE project_members SET role='viewer' WHERE project_id=${fixture.projectId} AND user_id=${fixture.userId}`;
      const client = await connect(fixture);
      const response = await rpc(client, request(fixture, action));
      expect(response).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(await collabActivityRows(fixture)).toEqual([]);
    });
  }

  it("P12 rejects a nonexistent Space before recording a user action", async () => {
    const fixture = await seedCollabActivity();
    const client = await connect(fixture);
    const body = SpaceRpcRequestSchema.parse({ id: randomUUID(), type: "space:rename", payload: { spaceId: randomUUID(), name: "Missing" } });
    expect(await rpc(client, body)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await collabActivityRows(fixture)).toEqual([]);
  });
});
