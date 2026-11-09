// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation preview route (inner#1711 design §4, §7.1): `GET /web-animation/<token>/index.html`.
 *
 * Our server signs `{sourceVersionId, packageKey, exp}` with the shared secret and carries it in one path segment as
 * base64url. The Worker reads the package back as `text/html` under a CSP whose `sandbox` keeps generated code away
 * from every origin even when the address is opened directly, lets fonts load only from this Worker's own origin, and
 * lets a browser cache the page no longer than the signature has left. Generated code is untrusted, and the browser
 * never holds our secret, so the token is the only thing that opens a package.
 */

import { env, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { signPayload } from "@shared/upload/signed-payload.js";
import { encodePreviewToken } from "@shared/timeline/web-animation.js";
import worker from "@ingest/index.js";

const ORIGIN = "https://preview.test.example";
const PACKAGE_KEY = "web-animation/p1/40000000-0000-4000-8000-000000000001/index.html";
const HTML = "<!doctype html><html><head></head><body><div data-duration=\"4\">Hello</div></body></html>";

/**
 * A token as our server mints it.
 * @param payload - What it signs.
 * @param secret - The secret it is signed with.
 * @returns The path segment.
 */
async function token(payload: unknown, secret = env.INGEST_SHARED_SECRET): Promise<string> {
  return encodePreviewToken(await signPayload(payload, secret));
}

/**
 * Ask the Worker for one preview path.
 * @param path - The path.
 * @param origin - The origin the request is addressed to.
 * @returns The response.
 */
async function open(path: string, origin = ORIGIN): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`), env, createExecutionContext());
}

/**
 * Store a package under a key.
 * @param key - Its storage key.
 * @returns Nothing.
 */
async function store(key = PACKAGE_KEY): Promise<void> {
  await env.BUCKET.put(key, HTML, { httpMetadata: { contentType: "application/octet-stream" } });
}

describe("GET /web-animation/<token>/index.html", () => {
  it("answers the stored package as text/html with the sandboxing CSP for the requested origin", async () => {
    await store();
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() + 120_000 })}/index.html`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      `img-src data:; font-src ${ORIGIN}; connect-src 'none'`,
    );
    await expect(res.text()).resolves.toBe(HTML);
  });

  it("names the origin the request was addressed to in font-src", async () => {
    await store();
    const other = "http://localhost:8787";
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() + 120_000 })}/index.html`, other);

    expect(res.headers.get("content-security-policy")).toContain(`font-src ${other};`);
  });

  it("lets a browser cache the page privately for no longer than the signature has left", async () => {
    await store();
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() + 120_000 })}/index.html`);

    const cache = res.headers.get("cache-control") ?? "";
    const match = /^private, max-age=(\d+)$/.exec(cache);
    expect(match, cache).not.toBeNull();
    const maxAge = Number(match![1]);
    expect(maxAge).toBeLessThanOrEqual(120);
    expect(maxAge).toBeGreaterThanOrEqual(110);
  });

  it("reads a token whose base64 form would carry / and +", async () => {
    // Keys and ids chosen so the standard base64 of the signed payload contains both characters.
    let found: { key: string; segment: string } | null = null;
    for (let i = 0; i < 200 && found === null; i += 1) {
      const key = `web-animation/p1/${i}?>/index.html`;
      const signed = await signPayload({ sourceVersionId: `s~${i}`, packageKey: key, exp: Date.now() + 120_000 }, env.INGEST_SHARED_SECRET);
      if (signed.includes("/") && signed.includes("+")) found = { key, segment: encodePreviewToken(signed) };
    }
    expect(found).not.toBeNull();
    await store(found!.key);
    const res = await open(`/web-animation/${found!.segment}/index.html`);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(HTML);
  });

  it("refuses an expired token", async () => {
    await store();
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() - 1 })}/index.html`);

    expect(res.status).toBe(401);
  });

  it("refuses a token signed with another secret", async () => {
    await store();
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() + 120_000 }, "someone-else")}/index.html`);

    expect(res.status).toBe(401);
  });

  it.each([
    ["not base64url", "not*base64"],
    ["base64url of something unsigned", encodePreviewToken("hello")],
  ])("refuses a token that is %s", async (_label, segment) => {
    const res = await open(`/web-animation/${segment}/index.html`);

    expect(res.status).toBe(401);
  });

  it("refuses a signed payload missing its key or expiry", async () => {
    await store();
    for (const payload of [{ sourceVersionId: "s1", exp: Date.now() + 120_000 }, { sourceVersionId: "s1", packageKey: PACKAGE_KEY }]) {
      const res = await open(`/web-animation/${await token(payload)}/index.html`);
      expect(res.status).toBe(401);
    }
  });

  it("answers 404 when the signed package is not stored", async () => {
    const res = await open(`/web-animation/${await token({ sourceVersionId: "s1", packageKey: "web-animation/p1/missing/index.html", exp: Date.now() + 120_000 })}/index.html`);

    expect(res.status).toBe(404);
  });

  it("serves nothing but index.html under a token", async () => {
    await store();
    const segment = await token({ sourceVersionId: "s1", packageKey: PACKAGE_KEY, exp: Date.now() + 120_000 });

    for (const path of [`/web-animation/${segment}/manifest.json`, `/web-animation/${segment}/`, `/web-animation/${segment}`]) {
      const res = await open(path);
      expect(res.status).toBe(404);
    }
  });
});
