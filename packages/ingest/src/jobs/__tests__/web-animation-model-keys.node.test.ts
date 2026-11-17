// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reading one web-animation model call's keys from our server (inner#1953): the Worker signs `{ executionId, upstreams }`
 * with the shared secret and a timestamp, posts it to the endpoint the job names, and opens the sealed answer with its
 * private key. What each answer becomes is our own logic, so it runs on Node against a stand-in server; the platform's
 * crypto under workerd is covered by `web-animation-model-keys.test.ts`.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  MODEL_KEYS_SIGNATURE_HEADER,
  MODEL_KEYS_TIMESTAMP_HEADER,
  sealModelKeys,
  verifyModelKeysRequest,
} from "@shared/upload/model-keys.js";
import { fetchModelKeys } from "@ingest/jobs/web-animation-model-keys.js";

const SECRET = "test-ingest-secret";
const TARGET = { url: "https://api.example.test/api/v1/ingest/model-keys", executionId: "40000000-0000-4000-8000-000000000001" };
const PAIR = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SECRETS = { sharedSecret: SECRET, privateKey: PAIR.privateKey };

/**
 * A stand-in server answering every request the same way, recording what it was sent.
 * @param answer - What it answers.
 * @returns The fetch and its recorder.
 */
function server(answer: () => Promise<Response>): ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>> {
  return vi.fn(async (_url: string, _init: RequestInit) => answer());
}

describe("fetchModelKeys", () => {
  it("posts the execution and upstreams to the job's endpoint, signed so the server's check accepts it", async () => {
    const send = server(async () => new Response(await sealModelKeys({ openrouter: "k" }, PAIR.publicKey), { status: 200 }));
    await fetchModelKeys(TARGET, ["openrouter", "deepseek"], SECRETS, send);

    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(TARGET.url);
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual({ executionId: TARGET.executionId, upstreams: ["openrouter", "deepseek"] });
    const headers = new Headers(init.headers);
    expect(await verifyModelKeysRequest({
      secret: SECRET,
      timestamp: headers.get(MODEL_KEYS_TIMESTAMP_HEADER) ?? undefined,
      signature: headers.get(MODEL_KEYS_SIGNATURE_HEADER) ?? undefined,
      body,
      nowSeconds: Math.floor(Date.now() / 1000),
      windowSeconds: 5,
    })).toBe("ok");
  });

  it("opens a sealed 200 into the keys by upstream", async () => {
    const send = server(async () => new Response(await sealModelKeys({ openrouter: "sk-or-1" }, PAIR.publicKey), { status: 200 }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "keys", keys: { openrouter: "sk-or-1" } });
  });

  it("reads account_key_missing as a refusal that fails the execution as account_key_missing, naming the upstream", async () => {
    const send = server(async () => Response.json({ code: "account_key_missing", upstream: "openrouter" }, { status: 409 }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "refused", reason: "account_key_missing", upstream: "openrouter" });
  });

  it("reads not_configured as a refusal that fails the execution as feature_disabled", async () => {
    const send = server(async () => Response.json({ code: "not_configured" }, { status: 409 }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "refused", reason: "feature_disabled" });
  });

  it("reads a seal it cannot open as a refusal that fails the execution as feature_disabled: the key pair does not match", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const send = server(async () => new Response(await sealModelKeys({ openrouter: "k" }, other.publicKey), { status: 200 }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "refused", reason: "feature_disabled", unreadable: true });
  });

  it("reads 404 as an execution no longer running, which ends only this call", async () => {
    const send = server(async () => Response.json({ code: "not_running" }, { status: 404 }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "not_running" });
  });

  it.each([401, 403, 409, 422, 429, 500, 503])("reads %i with no refusal it knows as unavailable, which the next call asks again", async (status) => {
    const send = server(async () => new Response("no", { status }));

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "unavailable", status });
  });

  it("reads a request that reached no server as unavailable", async () => {
    const send = server(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await fetchModelKeys(TARGET, ["openrouter"], SECRETS, send)).toEqual({ kind: "unavailable", status: null });
  });
});
