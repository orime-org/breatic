// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understanding through Gemini's own generateContent (design 6.5). Each item goes inline,
 * unless the request would pass the inline limit: then every item is first uploaded through
 * the Files API's resumable protocol, waited on until it is ACTIVE, sent by its uri, and
 * deleted once the call ends (https://ai.google.dev/gemini-api/docs/files).
 */

import type { FinishReason } from "ai";
import { z } from "zod";
import { deliver, SIDE_REQUEST_MS, wait, type OutgoingRequest } from "@provider/http/request.js";
import {
  AnswerUnread,
  assertSucceeded,
  base64Of,
  count,
  exchange,
  UnreadableAnswer,
  usageOf,
  wireTypeOf,
  type Answered,
  type UnderstandAdapter,
  type UnderstandCall,
  type UploadedFile,
} from "@provider/llm/understand/adapter.js";

/** Gemini's finish reasons that mean the answer was blocked. */
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** An uploaded file, as the Files API describes it. */
interface GeminiFile {
  name?: unknown;
  uri?: unknown;
  state?: unknown;
}

/**
 * The shape of the answer's fields that are read; other fields are let through. A blocked
 * candidate comes with no content, and so no parts.
 */
const generatedSchema = z.looseObject({
  candidates: z.array(z.looseObject({
    content: z.looseObject({ parts: z.array(z.looseObject({ text: z.unknown().optional(), thought: z.unknown().optional() })).optional() }).nullish(),
    finishReason: z.unknown().optional(),
  })).optional(),
  promptFeedback: z.unknown().optional(),
});

/** The answer's usage, as far as it is read. */
interface Generated {
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
 * One Files API step, sent once like the model request: a failing status throws HttpStatus
 * with its headers, so the route reads its Retry-After; the caller checks what the answer
 * promised.
 * @param call - The call, for its bounds.
 * @param request - The step's request.
 * @returns The answer, 2xx.
 * @throws {HttpStatus} When the step answers a failing status.
 * @throws {NotSent | NoAnswer | Aborted | BodyTooLarge} As provider's HTTP module classifies a failure; a step is not billed, so a lost body is its read's own failure.
 */
async function step(call: UnderstandCall, request: OutgoingRequest): Promise<Answered> {
  let answered: Answered;
  try {
    answered = await exchange(request, call);
  } catch (error) {
    throw error instanceof AnswerUnread ? error.cause : error;
  }
  assertSucceeded(answered);
  return answered;
}

/**
 * The file a Files API answer describes, under `file` for an upload and whole for a state poll.
 * @param answered - The step's answer.
 * @param wrapped - Whether the file sits under `file`.
 * @returns The file.
 * @throws {UnreadableAnswer} When the answer is not a JSON object.
 */
function fileOf(answered: Answered, wrapped: boolean): GeminiFile {
  const body = answered.body;
  if (typeof body !== "object" || body === null) throw new UnreadableAnswer(`Google's ${answered.url} answered something that is not JSON`);
  const file = wrapped ? (body as { file?: unknown }).file : body;
  return typeof file === "object" && file !== null ? file : {};
}

/**
 * Upload one item through the resumable protocol and register it on the call's session as
 * soon as the upload answer names it, its delete queued with it.
 * @param call - The call, for its key and bounds.
 * @param media - The item.
 * @param index - Its place, for its display name.
 * @param files - The session's files on this upstream, the new one appended.
 * @returns The registered file and its state as the upload answered it.
 * @throws {HttpStatus} When an upload step answers a failing status.
 * @throws {UnreadableAnswer} When a step answers no JSON, the start names no session or the upload no file.
 * @throws {NotSent | NoAnswer | Aborted | BodyTooLarge} As provider's HTTP module classifies a failure.
 */
async function upload(call: UnderstandCall, media: UnderstandCall["media"][number], index: number, files: UploadedFile[]): Promise<{ entry: UploadedFile; file: GeminiFile }> {
  const base = new URL(call.decl.base_url);
  const type = wireTypeOf(media.contentType);
  // The start's promise is its session header; its body says nothing.
  const started = await step(call, {
    url: `${base.origin}/upload${base.pathname.replace(/\/$/, "")}/files`,
    method: "POST",
    headers: {
      ...headers(call),
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(media.bytes.byteLength),
      "x-goog-upload-header-content-type": type,
    },
    body: JSON.stringify({ file: { display_name: `item-${index + 1}` } }),
  });
  const session = started.headers.get("x-goog-upload-url");
  if (session === null) throw new UnreadableAnswer("Google's upload start named no session");
  const file = fileOf(await step(call, {
    url: session,
    method: "POST",
    headers: { "x-goog-api-key": call.key, "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0", "content-type": type },
    body: media.bytes,
  }), true);
  if (typeof file.name !== "string") throw new UnreadableAnswer("Google's upload answered no file");
  const entry: UploadedFile = { url: `${call.decl.base_url}/${file.name}` };
  files.push(entry);
  // Deleted once the whole call ends; each delete is sent once in its own window, apart from the
  // call's deadline and signal, and a file left behind expires on Google's side.
  call.session.cleanups.push(() => {
    deliver({ url: entry.url, method: "DELETE", headers: { "x-goog-api-key": call.key } }, { replaySafe: false, deadlineAt: Date.now() + SIDE_REQUEST_MS })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  });
  return { entry, file };
}

/**
 * Wait until a registered file is ACTIVE and record its uri; with no state in hand, as on a
 * later attempt, its state is asked first.
 * @param call - The call, for its key, bounds and poll interval.
 * @param entry - The registered file.
 * @param known - Its state as the upload answered it, when this attempt uploaded it.
 * @throws {HttpStatus} When a poll answers a failing status.
 * @throws {UnreadableAnswer} When a poll answers no JSON, or the file ends FAILED or has no state or uri.
 * @throws {NotSent | NoAnswer | Aborted | BodyTooLarge} As provider's HTTP module classifies a failure.
 */
async function activate(call: UnderstandCall, entry: UploadedFile, known?: GeminiFile): Promise<void> {
  /**
   * The file's state, asked once.
   * @returns The file.
   * @throws {HttpStatus | UnreadableAnswer | NotSent | NoAnswer | Aborted | BodyTooLarge} As the step and its reading fail.
   */
  const poll = async (): Promise<GeminiFile> => fileOf(await step(call, { url: entry.url, method: "GET", headers: { "x-goog-api-key": call.key } }), false);
  let file = known ?? await poll();
  while (file.state !== "ACTIVE") {
    if (file.state === "FAILED") throw new UnreadableAnswer(`Google could not process ${entry.url}`);
    if (typeof file.state !== "string") throw new UnreadableAnswer(`Google's ${entry.url} has no state`);
    await wait(call.filePollMs, { replaySafe: false, deadlineAt: call.deadlineAt, signal: call.signal }, entry.url);
    file = await poll();
  }
  if (typeof file.uri !== "string") throw new UnreadableAnswer(`Google's ${entry.url} has no uri`);
  entry.uri = file.uri;
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
    const inline = request(call.media.map((m) => ({ inlineData: { mimeType: wireTypeOf(m.contentType), data: base64Of(m.bytes) } })));
    let body = inline;
    if (Buffer.byteLength(inline) > call.inlineMaxBytes) {
      // Uploaded once per call: a later attempt on this upstream reuses the registered files,
      // asks again about one not yet ready, and uploads from the first item not registered.
      const files = call.session.uploads.get(call.decl.base_url) ?? [];
      call.session.uploads.set(call.decl.base_url, files);
      for (const [index, media] of call.media.entries()) {
        const registered = files[index];
        if (registered === undefined) {
          const { entry, file } = await upload(call, media, index, files);
          await activate(call, entry, file);
        } else if (registered.uri === undefined) await activate(call, registered);
      }
      body = request(call.media.map((m, i) => ({ fileData: { mimeType: wireTypeOf(m.contentType), fileUri: files[i]!.uri } })));
    }
    return exchange({ url, method: "POST", headers: headers(call), body }, call);
  },

  read(body) {
    const generated = generatedSchema.safeParse(body);
    if (!generated.success) return { unreadable: `Google's answer has an unexpected shape: ${generated.error.issues[0]?.message ?? "unknown"}` };
    const candidate = generated.data.candidates?.[0];
    if (candidate === undefined) {
      const blockReason = (generated.data.promptFeedback as { blockReason?: unknown } | null | undefined)?.blockReason;
      return { text: "", finishReason: blockReason === undefined ? "other" : "content-filter" };
    }
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
