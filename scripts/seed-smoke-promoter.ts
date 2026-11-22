// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Makes an account an approved promoter for the smoke suite (inner#1868,
 * inner#1993 §10.2).
 *
 * Promoter applications live in the billing service. The suite files one
 * through the account's own endpoint there, signed as the product, then
 * approves it through the billing service's back-office endpoint, signed
 * with the back office's secret, the way an operator would.
 *
 * Reads `{ "userId": "...", "code": "..." }` from stdin and prints
 * `{ "code": "..." }`. Run it from the repository root, with `COMMERCE_API_URL`,
 * `COMMERCE_API_SECRET` and `INTERNAL_API_SECRET` in the local `.env`:
 *   echo '{"userId":"…","code":"SMOKE1"}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/seed-smoke-promoter.ts
 */

import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

await import("../packages/server/src/bootstrap-config.js");
const core = await import("../packages/core/dist/index.js");

const input = JSON.parse(await text(process.stdin)) as { userId?: unknown; code?: unknown };
if (typeof input.userId !== "string" || typeof input.code !== "string") {
  console.error('Expected {"userId": string, "code": string} on stdin.');
  process.exit(1);
}
const { userId, code } = input;
const timeoutMs = core.getCommerceConfig().call_timeout_ms;
const asProduct = { baseUrl: core.env.COMMERCE_API_URL, secret: core.env.COMMERCE_API_SECRET, signer: core.COMMERCE_SIGNERS.product };
const asOperator = { baseUrl: core.env.COMMERCE_API_URL, secret: core.env.INTERNAL_API_SECRET, signer: "smoke" };

try {
  if (core.env.COMMERCE_API_URL === "") throw new Error("COMMERCE_API_URL is not set: the billing service holds promoter applications");
  const panel = await core.signedCall(asProduct, { method: "GET", path: `/v1/users/${userId}/referral?locale=en`, timeoutMs });
  const termsVersion = (panel.body as { data?: { program?: { termsVersion?: string } } }).data?.program?.termsVersion ?? "";
  if (termsVersion === "") throw new Error("the billing service's promoter terms are not published; set promoter_terms_version in its legal.yaml");
  await core.signedCall(asProduct, {
    method: "POST",
    path: `/v1/users/${userId}/referral/applications?locale=en`,
    body: { country: "SG", channels: ["https://example.test/smoke"], plan: "Smoke suite promoter", termsVersion },
    idempotencyKey: `smoke-${randomUUID()}`,
    timeoutMs,
  });
  const pending = await core.signedCall(asOperator, { method: "GET", path: "/internal/v1/promoter-applications?status=pending&pageSize=100", timeoutMs });
  const application = (pending.body as { items?: Array<{ id: string; userId: string }> }).items?.find((row) => row.userId === userId);
  if (application === undefined) throw new Error("the pending application was not filed");
  const approved = await core.signedCall(asOperator, {
    method: "POST",
    path: `/internal/v1/promoter-applications/${application.id}/approve`,
    body: { reason: "smoke suite", code },
    idempotencyKey: `bo-${randomUUID()}`,
    timeoutMs,
  });
  const body = approved.body as { status?: string; referralCode?: string; code?: string };
  if (body.status !== "applied") throw new Error(`approval refused: ${body.code ?? approved.status}`);
  console.log(JSON.stringify({ code: body.referralCode }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
