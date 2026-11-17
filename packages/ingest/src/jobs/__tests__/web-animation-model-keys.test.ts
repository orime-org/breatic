// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The model-key channel on workerd itself (inner#1953): `jose` and WebCrypto are the platform's here, so this is where
 * a key pair made by the platform signs a request our server's check accepts and opens a seal made for it. The
 * answers' meanings are covered on Node in `web-animation-model-keys.node.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  MODEL_KEYS_SIGNATURE_HEADER,
  MODEL_KEYS_TIMESTAMP_HEADER,
  sealModelKeys,
  verifyModelKeysRequest,
} from "@shared/upload/model-keys.js";
import { fetchModelKeys } from "@ingest/jobs/web-animation-model-keys.js";

/**
 * One exported key as PEM.
 * @param label - The PEM label.
 * @param der - The DER bytes.
 * @returns The PEM.
 */
function pem(label: string, der: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`;
}

/**
 * A key pair made by workerd's own WebCrypto, as PEM.
 * @returns The SPKI public key and the PKCS#8 private key.
 */
async function platformKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["encrypt", "decrypt"],
  ) as CryptoKeyPair;
  return {
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey) as ArrayBuffer),
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer),
  };
}

const TARGET = { url: "https://api.example.test/api/v1/ingest/model-keys", executionId: "40000000-0000-4000-8000-000000000001" };

describe("fetchModelKeys on workerd", () => {
  it("signs a request the server accepts and opens the sealed keys with the Worker's private key", async () => {
    const { publicKey, privateKey } = await platformKeyPair();
    let accepted: string | undefined;
    const send = async (_url: string, init: RequestInit): Promise<Response> => {
      const headers = new Headers(init.headers);
      accepted = await verifyModelKeysRequest({
        secret: "workerd-secret",
        timestamp: headers.get(MODEL_KEYS_TIMESTAMP_HEADER) ?? undefined,
        signature: headers.get(MODEL_KEYS_SIGNATURE_HEADER) ?? undefined,
        body: String(init.body),
        nowSeconds: Math.floor(Date.now() / 1000),
        windowSeconds: 300,
      });
      return new Response(await sealModelKeys({ openrouter: "sk-or-workerd" }, publicKey), { status: 200 });
    };

    const fetched = await fetchModelKeys(TARGET, ["openrouter"], { sharedSecret: "workerd-secret", privateKey }, send);

    expect(accepted).toBe("ok");
    expect(fetched).toEqual({ kind: "keys", keys: { openrouter: "sk-or-workerd" } });
  });
});
