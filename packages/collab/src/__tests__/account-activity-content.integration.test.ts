// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { initCore, initLogger, loadLocales, rawPg as sql } from "@breatic/core";
import { projectMetaDocName, spaceContentDocName } from "@breatic/shared";
import { createActivityHook } from "@collab/hooks/account-activity.js";
import { activityBarrier, collabActivityRows, connectCollabActivity, rejectCollabActivity, seedCollabActivity, serveCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityClient, ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { awarenessFrame, statelessFrame, syncFrame, SYNC, WIRE, waitFor } from "./helpers/live-hocuspocus.js";

initCore(process.env);
loadLocales();
const running: Server[] = [];
const clients: ActivityClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) { client.socket.terminate(); client.document.destroy(); }
  for (const server of running.splice(0)) await server.destroy();
});

/**
 * Start the production activity hook behind native authentication and transport.
 * @param fixture - Account whose real Project is opened.
 * @param docName - Persisted Project document.
 * @param mode - Expected authorization mode.
 * @returns An authenticated native WebSocket client.
 * @throws {Error} When the listener or real authentication fails.
 */
async function connect(fixture: ActivityCollabFixture, docName: string, mode: "read-write" | "readonly" = "read-write"): Promise<ActivityClient> {
  const server = await serveCollabActivity({ beforeSync: createActivityHook(),
    onStateless: async ({ connection, payload }) => { connection.sendStateless(payload); } });
  running.push(server);
  const client = await connectCollabActivity(server, fixture, docName, mode);
  clients.push(client);
  client.socket.send(syncFrame(docName, WIRE.sync, SYNC.step1, Y.encodeStateVector(client.document)));
  await waitFor(() => client.document.getMap("activity-test").get("existing") === "preserved" || docName.endsWith("/meta"), "existing content sync");
  return client;
}

/**
 * Encode only the mutation produced by one transaction on the receiving document.
 * @param client - The synchronized document and native connection.
 * @param remove - Delete an existing item instead of adding one.
 * @returns Its actual Yjs update bytes.
 * @throws {Error} When Yjs does not emit the requested update.
 */
function change(client: ActivityClient, remove: boolean): Uint8Array {
  let update: Uint8Array | undefined;
  const capture = (bytes: Uint8Array): void => { update = bytes; };
  client.document.once("update", capture);
  if (remove) client.document.getMap("activity-test").delete("existing");
  else client.document.getMap("activity-test").set("client-change", "PRIVATE_DOCUMENT_BODY");
  if (!update) throw new Error("expected a Yjs mutation");
  return update;
}

/**
 * Read the structured log written by this suite's real service logger.
 * @param root - Owned temporary log directory.
 * @returns Complete service log contents.
 * @throws {Error} When an existing log cannot be read.
 */
async function logs(root: string): Promise<string> {
  const dir = join(root, "activity-content-test");
  const files = await readdir(dir).catch(() => [] as string[]);
  return (await Promise.all(files.filter((name) => name.endsWith(".log")).map((name) => readFile(join(dir, name), "utf8")))).join("\n");
}

describe("authenticated content SyncUpdate activity (inner#1893)", () => {
  for (const kind of ["canvas", "document", "timeline", "3d"] as const) {
    for (const mutation of ["struct", "deleteSet"] as const) {
      it(`P19 records ${kind} ${mutation} updates as the authenticated actor`, async () => {
        const fixture = await seedCollabActivity();
        const docName = spaceContentDocName(fixture.projectId, fixture.spaceIds[kind], kind);
        const client = await connect(fixture, docName);
        expect(await collabActivityRows(fixture)).toEqual([]);
        const update = change(client, mutation === "deleteSet");
        const decoded = Y.decodeUpdate(update);
        if (mutation === "deleteSet") { expect(decoded.structs).toHaveLength(0); expect(decoded.ds.clients.size).toBeGreaterThan(0); }
        else expect(decoded.structs.length).toBeGreaterThan(0);
        client.socket.send(syncFrame(docName, WIRE.sync, SYNC.update, update));
        await activityBarrier(client);
        const rows = await collabActivityRows(fixture);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: fixture.userId, project_id: fixture.projectId, kind: "project_edit" });
      });
    }

    it(`P19 excludes an empty ${kind} SyncUpdate after a successful real handshake`, async () => {
      const fixture = await seedCollabActivity();
      const docName = spaceContentDocName(fixture.projectId, fixture.spaceIds[kind], kind);
      const client = await connect(fixture, docName);
      const empty = new Y.Doc();
      client.socket.send(syncFrame(docName, WIRE.sync, SYNC.update, Y.encodeStateAsUpdate(empty)));
      empty.destroy();
      await activityBarrier(client);
      expect(await collabActivityRows(fixture)).toEqual([]);
    });
  }

  for (const step of [SYNC.step1, SYNC.step2] as const) {
    it(`P19 excludes handshake subtype ${step} even if Step2 carries structs`, async () => {
      const fixture = await seedCollabActivity();
      const client = await connect(fixture, spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas"));
      const payload = step === SYNC.step1 ? Y.encodeStateVector(client.document) : change(client, false);
      client.socket.send(syncFrame(client.documentName, WIRE.sync, step, payload));
      await activityBarrier(client);
      expect(await collabActivityRows(fixture)).toEqual([]);
    });
  }

  it("P19 excludes meta SyncUpdate, presence and vocabulary frames", async () => {
    const fixture = await seedCollabActivity();
    const client = await connect(fixture, projectMetaDocName(fixture.projectId), "readonly");
    const doc = new Y.Doc();
    doc.getMap("spaces").set("untrusted", { createdBy: fixture.userId });
    client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, Y.encodeStateAsUpdate(doc)));
    const awareness = encoding.createEncoder();
    encoding.writeVarUint(awareness, 1); encoding.writeVarUint(awareness, 42); encoding.writeVarUint(awareness, 1);
    encoding.writeVarString(awareness, JSON.stringify({ user: { id: fixture.userId } }));
    client.socket.send(awarenessFrame(client.documentName, encoding.toUint8Array(awareness)));
    client.socket.send(statelessFrame(client.documentName, JSON.stringify({ type: "vocabulary", version: 1 })));
    await activityBarrier(client);
    expect(await collabActivityRows(fixture)).toEqual([]);
    doc.destroy();
  });

  it("P19 refuses viewer mutations without recording user editing activity", async () => {
    const fixture = await seedCollabActivity();
    await sql`UPDATE studio_members SET role='guest' WHERE user_id=${fixture.userId}`;
    await sql`UPDATE project_members SET role='viewer' WHERE project_id=${fixture.projectId} AND user_id=${fixture.userId}`;
    const client = await connect(fixture, spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas"), "readonly");
    client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, change(client, false)));
    await activityBarrier(client);
    expect(await collabActivityRows(fixture)).toEqual([]);
    const serverDoc = running[0]!.hocuspocus.documents.get(client.documentName);
    expect(serverDoc?.getMap("activity-test").get("client-change")).toBeUndefined();
  });

  it("P09 keeps fresh content authentication and reconnection free of access events", async () => {
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const client = await connect(fixture, name);
    await activityBarrier(client);
    client.socket.terminate();
    const another = await connectCollabActivity(running[0]!, fixture, name);
    clients.push(another);
    await activityBarrier(another);
    expect(await collabActivityRows(fixture)).toEqual([]);
  });

  it("P20 rejects the frame before apply, logs the original PG failure and permits a later fresh connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "channel148-content-logs-"));
    initLogger("activity-content-test", { logsRoot: root, debug: true, console: "none" });
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const client = await connect(fixture, name);
    const serverDocument = running[0]!.hocuspocus.documents.get(name);
    if (!serverDocument) throw new Error("expected the authenticated content document");
    expect(serverDocument.getConnectionsCount()).toBe(1);
    const restore = await rejectCollabActivity(fixture);
    const update = change(client, false);
    try {
      client.socket.send(syncFrame(name, WIRE.sync, SYNC.update, update));
      await expect.poll(async () => await logs(root)).toContain("activity fixture append rejected");
      const output = await logs(root);
      expect(output).toContain(fixture.userId);
      expect(output).toContain(fixture.projectId);
      expect(output).not.toContain("PRIVATE_DOCUMENT_BODY");
      expect(output).not.toContain(fixture.cookie);
      expect(serverDocument.getMap("activity-test").get("client-change")).toBeUndefined();
      expect(await collabActivityRows(fixture)).toEqual([]);
      await expect.poll(() => client.replies.some((frame) => frame.docName === name && frame.type === WIRE.close)).toBe(true);
      expect(serverDocument.getConnectionsCount()).toBe(0);
    } finally { await restore(); }
    const resumed = await connectCollabActivity(running[0]!, fixture, name);
    clients.push(resumed);
    resumed.socket.send(syncFrame(name, WIRE.sync, SYNC.update, update));
    await activityBarrier(resumed);
    expect(await collabActivityRows(fixture)).toHaveLength(1);
  });
});
