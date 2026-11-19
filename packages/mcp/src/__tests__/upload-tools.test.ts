// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { abortUpload, beginUpload, finishUpload } from "@mcp/tools/upload-tools.js";
import { stubDeps, type ApiCall } from "@mcp/__tests__/tool-deps.js";

const PROJECT = randomUUID();
const SPACE = randomUUID();
const NODE = randomUUID();
const HASH = "a".repeat(64);
const PICTURE = { name: "cat.png", contentType: "image/png", size: 2048, sha256: HASH };

const TICKET = {
  uploadId: "up-1",
  token: "tok-1",
  storageKey: "studio/k.png",
  uploadUrl: "https://ingest.example",
  kind: "image",
  partSize: 1024,
  totalParts: 2,
  taskId: "task-u",
};

/**
 * Deps whose collab places the upload nodes and whose server answers as told.
 * @param api - The server.
 * @returns The stubbed deps.
 */
const depsWith = (api: (call: ApiCall) => unknown): ReturnType<typeof stubDeps> =>
  stubDeps({
    reply: (command) =>
      command.type === "create_upload_nodes"
        ? { status: "done", result: { nodeIds: ["n-1", "n-2"].slice(0, (command.params as { files: unknown[] }).files.length) } }
        : command.type === "check_upload_target"
          ? { status: "done", result: { nodeId: NODE } }
          : { status: "done", result: { blockIds: ["b-new"] } },
    api: (call) => (call.path === "/assets/upload-config" ? { assetUrlPrefix: "https://cdn/", uploadStatusPollSeconds: 0 } : api(call)),
  });

describe("begin_upload", () => {
  it("places the node after the one named, asks for its ticket and hands back where each part goes", async () => {
    const { deps, submitted, calls } = depsWith(() => TICKET);
    const { value } = await beginUpload.run(deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "canvas", afterNodeId: NODE } });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([["create_upload_nodes", { files: [{ type: "image", name: "cat.png" }], afterNodeId: NODE }]]);
    expect(calls.find((c) => c.path === "/assets/upload-ticket")!.body).toEqual({
      filename: "cat.png",
      content_type: "image/png",
      project_id: PROJECT,
      size: 2048,
      client_hash: HASH,
      node_id: "n-1",
      space_id: SPACE,
    });
    expect(value).toEqual({
      files: [
        {
          name: "cat.png",
          state: "send",
          nodeId: "n-1",
          taskId: "task-u",
          partSize: 1024,
          totalParts: 2,
          partUrl: "https://ingest.example/uploads/up-1/parts/{partNumber}",
          token: "tok-1",
          finish: { uploadId: "up-1" },
        },
      ],
    });
  });

  it("checks the node a file goes into, and ends a file the studio already holds", async () => {
    const { deps, submitted } = depsWith(() => ({ alreadyExists: true, assetId: "a", fileUrl: "https://cdn/x.png", kind: "image", width: 10, height: 20, taskId: "t" }));
    const { value } = await beginUpload.run(deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "into_node", nodeId: NODE } });
    expect(submitted.map((c) => [c.type, c.params])).toEqual([["check_upload_target", { nodeId: NODE, type: "image" }]]);
    expect(value).toEqual({ files: [{ name: "cat.png", state: "stored", nodeId: NODE, url: "https://cdn/x.png", width: 10, height: 20 }] });
  });

  it("asks for a detached ticket with no node and no Space", async () => {
    const { deps, submitted, calls } = depsWith(() => ({ ...TICKET, taskId: undefined }));
    const { value } = await beginUpload.run(deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "detached" } });
    expect(submitted).toEqual([]);
    expect(calls.find((c) => c.path === "/assets/upload-ticket")!.body).not.toHaveProperty("node_id");
    expect(calls.find((c) => c.path === "/assets/upload-ticket")!.body).not.toHaveProperty("space_id");
    expect((value as { files: Array<Record<string, unknown>> }).files[0]).not.toHaveProperty("nodeId");
  });

  it("writes a document's held file in at once, and carries where it goes into the finish", async () => {
    const held = depsWith(() => ({ alreadyExists: true, assetId: "a", fileUrl: "https://cdn/x.png", kind: "image", width: 10, height: 20 }));
    const { value } = await beginUpload.run(held.deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "document", afterBlockId: "b-1" } });
    expect(held.submitted.map((c) => [c.type, c.params])).toEqual([
      ["insert_document_blocks", { afterBlockId: "b-1", blocks: [{ type: "image", props: { url: "https://cdn/x.png", name: "cat.png", mediaWidth: 10, mediaHeight: 20 } }] }],
    ]);
    expect(value).toEqual({ files: [{ name: "cat.png", state: "stored", url: "https://cdn/x.png", width: 10, height: 20, blockId: "b-new" }] });
    const sending = depsWith(() => ({ ...TICKET, taskId: undefined }));
    const begun = await beginUpload.run(sending.deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "document", afterBlockId: "b-1" } });
    expect((begun.value as { files: Array<{ finish: unknown }> }).files[0]!.finish).toEqual({ uploadId: "up-1", document: { spaceId: SPACE, afterBlockId: "b-1", type: "image", name: "cat.png" } });
  });

  it("refuses a file that is not a picture, a video or a sound before asking for anything", async () => {
    const { deps, submitted, calls } = depsWith(() => TICKET);
    await expect(
      beginUpload.run(deps, { projectId: PROJECT, spaceId: SPACE, files: [{ ...PICTURE, contentType: "application/pdf" }], destination: { kind: "detached" } }),
    ).rejects.toMatchObject({ reason: "invalid_request" });
    expect([submitted, calls]).toEqual([[], []]);
  });

  it("says why a ticket the server could not open failed", async () => {
    const { deps } = depsWith(() => ({ openFailed: { reason: "storage_unavailable" }, taskId: "t" }));
    const { value } = await beginUpload.run(deps, { projectId: PROJECT, spaceId: SPACE, files: [PICTURE], destination: { kind: "detached" } });
    expect(value).toEqual({ files: [{ name: "cat.png", state: "failed", reason: "storage_unavailable" }] });
  });
});

describe("finish_upload", () => {
  const parts = [
    { partNumber: 1, etag: "e1" },
    { partNumber: 2, etag: "e2" },
  ];

  it("has the server finish with the last token, then waits until it is stored", async () => {
    let asked = 0;
    const { deps, calls } = depsWith((call) => {
      if (call.path === "/assets/uploads/up-1/complete") return { storageKey: "studio/k.png" };
      asked += 1;
      return { items: [asked === 1 ? { key: "studio/k.png", state: "finishing" } : { key: "studio/k.png", state: "completed", result: { fileUrl: "https://cdn/k.png", width: 4, height: 3 } }] };
    });
    const { value } = await finishUpload.run(deps, { projectId: PROJECT, uploadId: "up-1", token: "tok-9", parts });
    const complete = calls.find((c) => c.path === "/assets/uploads/up-1/complete")!;
    expect([complete.body, complete.headers]).toEqual([{ parts }, { "x-upload-token": "tok-9" }]);
    expect(calls.filter((c) => c.path === "/assets/upload-status").map((c) => c.query)).toEqual([{ key: "studio/k.png" }, { key: "studio/k.png" }]);
    expect(value).toEqual({ state: "stored", url: "https://cdn/k.png", width: 4, height: 3 });
  });

  it("writes a document's file in once it is stored", async () => {
    const { deps, submitted } = depsWith((call) =>
      call.path.endsWith("/complete") ? { storageKey: "k" } : { items: [{ key: "k", state: "completed", result: { fileUrl: "https://cdn/k.mp4", width: null, height: null } }] },
    );
    const { value } = await finishUpload.run(deps, {
      projectId: PROJECT,
      uploadId: "up-1",
      token: "t",
      parts,
      document: { spaceId: SPACE, afterBlockId: "b-1", type: "video", name: "clip.mp4" },
    });
    expect(submitted.map((c) => [c.type, c.spaceId, c.params])).toEqual([
      ["insert_document_blocks", SPACE, { afterBlockId: "b-1", blocks: [{ type: "video", props: { url: "https://cdn/k.mp4", name: "clip.mp4" } }] }],
    ]);
    expect(value).toMatchObject({ state: "stored", blockId: "b-new" });
  });

  it("refuses with the reason a failed finish gives", async () => {
    const { deps } = depsWith((call) => (call.path.endsWith("/complete") ? { storageKey: "k" } : { items: [{ key: "k", state: "failed", reason: "hash_mismatch" }] }));
    await expect(finishUpload.run(deps, { projectId: PROJECT, uploadId: "up-1", token: "t", parts })).rejects.toMatchObject({ reason: "upload_failed" });
  });

  it("refuses at once a finish the server does not know, rather than waiting out the call", async () => {
    const { deps, calls } = depsWith((call) => (call.path.endsWith("/complete") ? { storageKey: "k" } : { items: [{ key: "k", state: "unknown" }] }));
    await expect(finishUpload.run(deps, { projectId: PROJECT, uploadId: "up-1", token: "t", parts })).rejects.toMatchObject({ reason: "upload_failed" });
    expect(calls.filter((c) => c.path === "/assets/upload-status")).toHaveLength(1);
  });

  it("says to ask again when the finish outlasts the call", async () => {
    const { deps } = depsWith((call) => (call.path.endsWith("/complete") ? { storageKey: "k" } : { items: [{ key: "k", state: "finishing" }] }));
    deps.call.startedAt = Date.now() - deps.config.call_timeout_ms;
    const { value } = await finishUpload.run(deps, { projectId: PROJECT, uploadId: "up-1", token: "t", parts });
    expect(value).toEqual({ state: "finishing" });
  });
});

describe("abort_upload", () => {
  it("reports the transfer failed on the node's task, as the browser does", async () => {
    const { deps, calls } = depsWith(() => ({ counts: {} }));
    const { value } = await abortUpload.run(deps, { projectId: PROJECT, taskId: NODE });
    expect(calls.map((c) => [c.path, c.body])).toEqual([[`/canvas/node-tasks/${NODE}/failure`, { reason: "aborted" }]]);
    expect(value).toEqual({ aborted: true });
  });
});
