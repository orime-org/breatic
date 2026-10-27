// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understanding through Gemini's own generateContent (design 6.5). Each item goes inline,
 * unless the request would pass the inline limit: then every item is first uploaded through
 * the Files API's resumable protocol, waited on until it is ACTIVE, sent by its uri, and
 * deleted once the call ends (https://ai.google.dev/gemini-api/docs/files).
 */

import type { FinishReason } from "ai";
import { HttpStatus } from "@provider/http/errors.js";
import { fetchJson, send, wait } from "@provider/http/request.js";
import { base64Of, count, exchange, usageOf, type UnderstandAdapter, type UnderstandCall } from "@provider/llm/understand/adapter.js";

/** Gemini's finish reasons that mean the answer was blocked. */
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** The largest file description read, in bytes. */
const MAX_FILE_JSON_BYTES = 1024 * 1024;

/** An uploaded file, as the Files API describes it. */
interface GeminiFile {
  name?: unknown;
  uri?: unknown;
  state?: unknown;
}

/** The answer's body, as far as it is read. */
interface Generated {
  candidates?: { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: { promptTokenCount?: unknown; cachedContentTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
}

/**
 * Gemini's finish reason in the AI SDK's words.
 * @param reason - Gemini's reason.
 * @returns The unified word.
 */
function finishOf(reason: unknown): FinishReason {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return typeof reason === "string" && BLOCKED.has(reason) ? "content-filter" : "other";
}

/**
 * The headers of every request.
 * @param call - The call.
 * @returns The key and a JSON body type.
 */
function headers(call: UnderstandCall): Record<string, string> {
  return { "x-goog-api-key": call.key, "content-type": "application/json" };
}

/**
 * Upload one item through the resumable protocol and wait until it is ACTIVE.
 * @param call - The call, for its key, bounds and poll interval.
 * @param media - The item.
 * @param index - Its place, for its display name.
 * @param uploaded - Where the name of each file is kept for deleting, as soon as it exists.
 * @returns The file's uri.
 * @throws {HttpStatus} When the upload answers no session or the file ends FAILED.
 * @throws {NotSent | NoAnswer | Aborted} As provider's HTTP module classifies a failure.
 */
async function upload(call: UnderstandCall, media: UnderstandCall["media"][number], index: number, uploaded: string[]): Promise<string> {
  const base = new URL(call.decl.base_url);
  const startUrl = `${base.origin}/upload${base.pathname.replace(/\/$/, "")}/files`;
  const bounds = { replaySafe: false, deadlineAt: call.deadlineAt, signal: call.signal };
  const started = await send(
    {
      url: startUrl,
      method: "POST",
      headers: {
        ...headers(call),
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(media.bytes.byteLength),
        "x-goog-upload-header-content-type": media.contentType,
      },
      body: JSON.stringify({ file: { display_name: `item-${index + 1}` } }),
    },
    bounds,
  );
  await started.body?.cancel();
  const session = started.headers.get("x-goog-upload-url");
  if (started.status < 200 || started.status >= 300 || session === null) throw new HttpStatus(startUrl, started.status, "no upload session");
  const limits = { maxBodyBytes: MAX_FILE_JSON_BYTES, idleMs: Math.max(1, call.deadlineAt - Date.now()) };
  const finished = await fetchJson(
    {
      url: session,
      method: "POST",
      headers: { "x-goog-api-key": call.key, "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0", "content-type": media.contentType },
      body: media.bytes,
    },
    { ...bounds, ...limits },
  );
  let file = (finished as { file?: GeminiFile } | null)?.file ?? {};
  if (typeof file.name !== "string") throw new HttpStatus(session, 200, "the upload answered no file");
  uploaded.push(file.name);
  const fileUrl = `${call.decl.base_url}/${file.name}`;
  while (file.state !== "ACTIVE") {
    if (file.state === "FAILED") throw new HttpStatus(fileUrl, 200, `file ${String(file.name)} failed to process`);
    await wait(call.filePollMs, bounds, fileUrl);
    file = (await fetchJson({ url: fileUrl, method: "GET", headers: { "x-goog-api-key": call.key } }, { ...bounds, replaySafe: true, ...limits })) as GeminiFile;
  }
  if (typeof file.uri !== "string") throw new HttpStatus(fileUrl, 200, "the file has no uri");
  return file.uri;
}

export const googleUnderstand: UnderstandAdapter = {
  async ask(call) {
    const url = `${call.decl.base_url}/models/${call.modelId}:generateContent`;
    /**
     * The request with the media in the given parts.
     * @param items - One part per item.
     * @returns The JSON body.
     */
    const request = (items: Record<string, unknown>[]): string => JSON.stringify({
      contents: [{ role: "user", parts: [{ text: call.question }, ...items.flatMap((item, index) => [{ text: `Item ${index + 1}` }, item])] }],
      generationConfig: { maxOutputTokens: call.maxOutputTokens },
    });
    const inline = request(call.media.map((m) => ({ inlineData: { mimeType: m.contentType, data: base64Of(m.bytes) } })));
    const uploaded: string[] = [];
    try {
      let body = inline;
      if (Buffer.byteLength(inline) > call.inlineMaxBytes) {
        const uris: string[] = [];
        for (const [index, media] of call.media.entries()) uris.push(await upload(call, media, index, uploaded));
        body = request(call.media.map((m, i) => ({ fileData: { mimeType: m.contentType, fileUri: uris[i]! } })));
      }
      return await exchange({ url, method: "POST", headers: headers(call), body }, call);
    } finally {
      // Deletes are best effort: a file left behind expires on Google's side.
      for (const name of uploaded) {
        await send({ url: `${call.decl.base_url}/${name}`, method: "DELETE", headers: { "x-goog-api-key": call.key } }, { replaySafe: true, deadlineAt: call.deadlineAt })
          .then((r) => r.body?.cancel())
          .catch(() => undefined);
      }
    }
  },

  read(body) {
    const generated = (body ?? {}) as Generated;
    const candidate = generated.candidates?.[0];
    if (candidate === undefined) return { text: "", finishReason: generated.promptFeedback?.blockReason === undefined ? "other" : "content-filter" };
    const text = (candidate.content?.parts ?? [])
      .filter((p) => p.thought !== true && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    return { text, finishReason: finishOf(candidate.finishReason) };
  },

  billing(body) {
    const usage = ((body ?? {}) as Generated).usageMetadata;
    const thoughts = count(usage?.thoughtsTokenCount);
    return {
      usage: usageOf(count(usage?.promptTokenCount), count(usage?.cachedContentTokenCount), count(usage?.candidatesTokenCount) + thoughts, thoughts),
      providerMetadata: {},
    };
  },
};
