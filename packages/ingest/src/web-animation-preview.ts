// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The web-animation preview route (inner#1711 design §7.1): `GET /web-animation/<token>/index.html`.
 *
 * Our server signs `{sourceVersionId, packageKey, exp}` with the shared secret and carries it in one path segment as
 * base64url; the browser never holds the secret, so the token is the only thing that opens a package. The package is
 * generated code, so it is answered as `text/html` only here, under a CSP whose `sandbox` keeps it away from every
 * origin even when the address is opened directly, lets fonts load only from this Worker's own origin, and lets a
 * browser cache the page no longer than the signature has left. The font files themselves are static assets.
 */

import { decodePreviewToken } from "@breatic/shared/space-content";
import { readSignedPayload } from "@breatic/shared";

/** `/web-animation/<token>/index.html`. */
export const WEB_ANIMATION_PREVIEW_PATH = /^\/web-animation\/([^/]+)\/index\.html$/;

/** The prefix every package key lives under. */
const PACKAGE_PREFIX = "web-animation/";

/** What a preview token signs. */
interface PreviewPayload {
  sourceVersionId?: unknown;
  packageKey?: unknown;
  exp?: unknown;
}

/**
 * Answer one preview page.
 * @param request - The request; its origin is the one fonts may load from.
 * @param bucket - The R2 binding.
 * @param secret - The shared secret the token is signed with.
 * @param segment - The token's path segment.
 * @returns 200 with the package; 401 for a token that is malformed, forged or expired; 404 when the package is not stored.
 * @throws {Error} When R2 cannot be read.
 */
export async function serveWebAnimationPreview(request: Request, bucket: R2Bucket, secret: string, segment: string): Promise<Response> {
  const unauthorized = new Response("Unauthorized", { status: 401 });
  const signed = decodePreviewToken(segment);
  if (signed === null) return unauthorized;
  const reading = await readSignedPayload<PreviewPayload>(signed, secret);
  if (!reading.ok || typeof reading.payload !== "object" || reading.payload === null) return unauthorized;
  const { packageKey, exp } = reading.payload;
  const now = Date.now();
  if (typeof packageKey !== "string" || !packageKey.startsWith(PACKAGE_PREFIX) || typeof exp !== "number" || exp <= now) return unauthorized;

  const object = await bucket.get(packageKey);
  if (object === null) return new Response("No such package", { status: 404 });
  const origin = new URL(request.url).origin;
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        `img-src data:; font-src ${origin}; connect-src 'none'`,
      "cache-control": `private, max-age=${Math.floor((exp - now) / 1000)}`,
      "x-content-type-options": "nosniff",
    },
  });
}
