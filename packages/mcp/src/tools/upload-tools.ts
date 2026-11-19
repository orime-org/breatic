// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Uploading a file from the agent's machine (#1488 design §10.2), in the
 * browser's order: place the nodes the files fill, ask for a ticket per file,
 * let the agent send the parts to the ingest Worker itself, then have our
 * server finish and wait for the stored file. The ingest Worker reads hash,
 * size and type off the stored bytes, as it does for the browser.
 */

import { z } from "zod";
import { defineTool, runCommandNow, ToolRefusal, type ToolDeps } from "@mcp/tools/kit.js";

/** The media a file can land as. */
type MediaType = "image" | "video" | "audio";

/**
 * The node or block a file becomes, by its type, as the browser's picker decides.
 * @param contentType - The file's MIME type.
 * @returns Its media type, or undefined for any other file.
 */
function mediaTypeOf(contentType: string): MediaType | undefined {
  const family = contentType.split("/")[0];
  return family === "image" || family === "video" || family === "audio" ? family : undefined;
}

/** What the ticket route answers. */
type TicketAnswer =
  | { uploadId: string; token: string; uploadUrl: string; partSize: number; totalParts: number; taskId?: string }
  | { alreadyExists: true; fileUrl: string; width: number | null; height: number | null }
  | { openFailed: { reason: string } };

/** Where a document's file goes, carried from `begin_upload` to `finish_upload`. */
const documentPlace = z.object({
  spaceId: z.uuid(),
  afterBlockId: z.string().min(1).optional(),
  type: z.enum(["image", "video", "audio"]),
  name: z.string().min(1),
});

/** A stored file. */
interface Stored {
  url: string;
  width: number | null;
  height: number | null;
}

/**
 * Write a stored file into a document as its media block.
 * @param deps - The call.
 * @param projectId - The Project.
 * @param place - Where it goes.
 * @param stored - The stored file.
 * @returns The new block's id.
 * @throws {ToolRefusal} When collab refuses or does not answer in time.
 */
async function insertMedia(deps: ToolDeps, projectId: string, place: z.infer<typeof documentPlace>, stored: Stored): Promise<string | undefined> {
  const sized = stored.width !== null && stored.height !== null && stored.width > 0 && stored.height > 0;
  const block = { type: place.type, props: { url: stored.url, name: place.name, ...(sized ? { mediaWidth: stored.width, mediaHeight: stored.height } : {}) } };
  const { blockIds } = (await runCommandNow(deps, {
    type: "insert_document_blocks",
    projectId,
    spaceId: place.spaceId,
    params: { ...(place.afterBlockId === undefined ? {} : { afterBlockId: place.afterBlockId }), blocks: [block] },
  })) as { blockIds: string[] };
  return blockIds[0];
}

/**
 * The stored file in what a tool answers.
 * @param stored - The stored file.
 * @returns Its address and size.
 */
const storedValue = (stored: Stored): Record<string, unknown> => ({ url: stored.url, width: stored.width, height: stored.height });

const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("canvas"), afterNodeId: z.uuid().optional().describe("Place the new nodes downstream of this node, wired from it.") }),
  z.object({ kind: z.literal("into_node"), nodeId: z.uuid().describe("An empty node of the file's type.") }),
  z.object({ kind: z.literal("document"), afterBlockId: z.string().min(1).optional().describe("Insert after this block; at the end when left out.") }),
  z.object({ kind: z.literal("detached") }),
]);

export const beginUpload = defineTool({
  name: "begin_upload",
  description:
    "Start uploading pictures, videos or sounds from your machine. Compute each file's sha256 first (sha256sum / shasum -a 256). Destinations: canvas (new nodes, framed in a group for two or more; after a node to wire them from it), " +
    "into_node (fill one empty node), document (one file, inserted as a media block in this document Space), detached (stored only, to pass to run_mini_tool as a mask, sketch or padded picture). " +
    "Per file the answer is stored (nothing to send), failed, or send: cut the file into totalParts pieces of partSize bytes, and for n = 1..totalParts " +
    "`curl -X PUT --data-binary @part_n -H 'x-upload-token: <token>' <partUrl with {partNumber} = n>`; each answer is JSON {partNumber, etag, token}: keep every {partNumber, etag} and send the next part with the token the last answer gave. " +
    "Then call finish_upload with the file's finish fields, the last token and the parts. If sending fails or you stop, call abort_upload with the file's taskId.",
  input: z.object({
    projectId: z.uuid(),
    spaceId: z.uuid().describe("The canvas or document Space the files go into."),
    files: z
      .array(
        z.object({
          name: z.string().min(1),
          contentType: z.string().min(3).describe("MIME type, such as image/png."),
          size: z.number().int().positive().describe("Bytes."),
          sha256: z.string().regex(/^[0-9a-f]{64}$/).describe("Lower-case hex."),
        }),
      )
      .min(1),
    destination,
  }),
  readOnly: false,
  run: async (deps, args) => {
    const types = args.files.map((file) => mediaTypeOf(file.contentType));
    if (types.some((type) => type === undefined)) {
      throw new ToolRefusal("invalid_request", "Only pictures, videos and sounds upload; write text into a text node with create_canvas_nodes or into a document with insert_document_blocks.");
    }
    const kinds = types as MediaType[];
    const { destination: to } = args;
    if ((to.kind === "into_node" || to.kind === "document") && args.files.length > 1) {
      throw new ToolRefusal("invalid_request", `A ${to.kind} upload takes one file; call again for the next.`);
    }
    const where = { projectId: args.projectId, spaceId: args.spaceId };
    let nodeIds: string[] = [];
    if (to.kind === "canvas") {
      const files = args.files.map((file, i) => ({ type: kinds[i]!, name: file.name }));
      ({ nodeIds } = (await runCommandNow(deps, { type: "create_upload_nodes", ...where, params: { files, ...(to.afterNodeId === undefined ? {} : { afterNodeId: to.afterNodeId }) } })) as { nodeIds: string[] });
    } else if (to.kind === "into_node") {
      await runCommandNow(deps, { type: "check_upload_target", ...where, params: { nodeId: to.nodeId, type: kinds[0]! } });
      nodeIds = [to.nodeId];
    }
    const files = [];
    for (const [i, file] of args.files.entries()) {
      const nodeId = nodeIds[i];
      const place = to.kind === "document" ? { spaceId: args.spaceId, ...(to.afterBlockId === undefined ? {} : { afterBlockId: to.afterBlockId }), type: kinds[i]!, name: file.name } : undefined;
      const answer = await deps.api.post<TicketAnswer>("/assets/upload-ticket", {
        filename: file.name,
        content_type: file.contentType,
        project_id: args.projectId,
        size: file.size,
        client_hash: file.sha256,
        ...(nodeId === undefined ? {} : { node_id: nodeId, space_id: args.spaceId }),
      });
      const base = { name: file.name, ...(nodeId === undefined ? {} : { nodeId }) };
      if ("alreadyExists" in answer) {
        const stored = { url: answer.fileUrl, width: answer.width, height: answer.height };
        const blockId = place ? await insertMedia(deps, args.projectId, place, stored) : undefined;
        files.push({ ...base, state: "stored", ...storedValue(stored), ...(blockId === undefined ? {} : { blockId }) });
      } else if ("openFailed" in answer) {
        files.push({ ...base, state: "failed", reason: answer.openFailed.reason });
      } else {
        files.push({
          ...base,
          state: "send",
          ...(answer.taskId === undefined ? {} : { taskId: answer.taskId }),
          partSize: answer.partSize,
          totalParts: answer.totalParts,
          partUrl: `${answer.uploadUrl}/uploads/${answer.uploadId}/parts/{partNumber}`,
          token: answer.token,
          finish: { uploadId: answer.uploadId, ...(place ? { document: place } : {}) },
        });
      }
    }
    return { value: { files } };
  },
});

/** One upload's state, as `GET /assets/upload-status` answers it. */
interface UploadStatusItem {
  key: string;
  state: "finishing" | "completed" | "transferred" | "failed" | "unknown";
  result?: { fileUrl: string; width: number | null; height: number | null };
  reason?: string;
}

export const finishUpload = defineTool({
  name: "finish_upload",
  description:
    "Finish an upload once every part is sent: pass the file's finish fields from begin_upload, the token the last part answered with, and every {partNumber, etag}. " +
    "Waits until the file is stored; on a canvas the node then shows it. Answers stored with the file's address (and blockId for a document), or finishing when it outlasts this call: call again with the same arguments, which is safe.",
  input: z.object({
    projectId: z.uuid(),
    uploadId: z.string().min(1),
    token: z.string().min(1),
    parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) })).min(1),
    document: documentPlace.optional(),
  }),
  readOnly: false,
  run: async (deps, args) => {
    const { storageKey } = await deps.api.post<{ storageKey: string }>(`/assets/uploads/${args.uploadId}/complete`, { parts: args.parts }, { headers: { "x-upload-token": args.token } });
    const { uploadStatusPollSeconds } = await deps.api.get<{ uploadStatusPollSeconds: number }>("/assets/upload-config");
    // Leave the document write its own wait.
    const deadline = deps.call.startedAt + deps.config.call_timeout_ms - deps.config.command_wait_ms;
    while (Date.now() < deadline) {
      const { items } = await deps.api.get<{ items: UploadStatusItem[] }>("/assets/upload-status", { key: storageKey });
      const status = items.find((item) => item.key === storageKey);
      if (status?.state === "completed" && status.result) {
        const stored = { url: status.result.fileUrl, width: status.result.width, height: status.result.height };
        const blockId = args.document ? await insertMedia(deps, args.projectId, args.document, stored) : undefined;
        return { value: { state: "stored", ...storedValue(stored), ...(blockId === undefined ? {} : { blockId }) } };
      }
      if (status?.state !== "finishing") throw new ToolRefusal("upload_failed", `The upload did not store: ${status?.reason ?? status?.state ?? "unknown"}.`);
      await new Promise((resolve) => setTimeout(resolve, uploadStatusPollSeconds * 1000));
    }
    return { value: { state: "finishing" } };
  },
});

export const abortUpload = defineTool({
  name: "abort_upload",
  description:
    "End an upload whose parts could not be sent, or that you stopped: the node it was filling records a failed upload, as when a browser upload breaks, and can be deleted or filled again. " +
    "Pass the taskId begin_upload gave; an upload with no taskId (detached or into a document) needs no abort.",
  input: z.object({ projectId: z.uuid(), taskId: z.uuid() }),
  readOnly: false,
  run: async (deps, args) => {
    await deps.api.post(`/canvas/node-tasks/${args.taskId}/failure`, { reason: "aborted" });
    return { value: { aborted: true } };
  },
});

/** The upload tools. */
export const UPLOAD_TOOLS = [beginUpload, finishUpload, abortUpload];
