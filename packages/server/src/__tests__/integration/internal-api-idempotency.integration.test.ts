// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Idempotency of the internal write endpoints (inner#1410 §4.6, §9,
 * acceptance #6), over a real socket against real Postgres and Redis, aimed
 * at the back office's credit grants.
 *
 * A grant's key is `bo-<uuid>`. It is locked inside the write transaction and
 * looked up there, so two requests with one key queue on the lock whatever
 * account they target. Unseen → run and store the decision (applied or
 * refused) under the key; same fingerprint → replay the stored decision;
 * different fingerprint → 409 `idempotency_conflict`. A request refused before
 * the handler runs (the body or the key fails validation) stores nothing and
 * leaves the key free.
 *
 * The fingerprint is `sha256(method \n route template \n account id \n
 * canonical JSON of { adminId, body })` over the parsed body, kept in
 * `request_hash`. Same-key replays, conflicts on each intent field and the
 * operation lookup are pinned in `internal-api-credit-grants`; this suite pins
 * what the key mechanism adds around them.
 */

import { describe, expect, it } from "vitest";
import { call, useInternalApp, type CallResult } from "./internal-api-harness.js";
import {
  GRANT_ADMIN,
  applied,
  fundingState,
  grantBody,
  grantKey,
  grantPath,
  postGrant,
  seedPersonal,
  type PersonalFixture,
} from "./operator-credit-grant-fixtures.js";

const suite = useInternalApp("internal-api-idempotency-test");

/**
 * An account with a personal Studio a grant can fund.
 * @returns The seeded account.
 */
function account(): Promise<PersonalFixture> {
  return seedPersonal(suite.sql, "internal-api-idempotency");
}

/**
 * The accounts whose stored decision holds a key.
 * @param key - The key.
 * @returns Target account ids, one per stored decision.
 */
async function holdersOf(key: string): Promise<string[]> {
  const rows = await suite.sql<{ target_user_id: string }[]>`
    SELECT target_user_id FROM credit_grant_operations WHERE key = ${key}
  `;
  return rows.map((r) => r.target_user_id);
}

/**
 * Assert a 409 that lost its key to another request.
 * @param res - The answer.
 */
function expectConflict(res: CallResult): void {
  expect(res.status).toBe(409);
  expect(res.json).toEqual({ code: "idempotency_conflict" });
}

describe("same key, same request: replay", () => {
  it("a body with the same fields in another order is the same request (canonical JSON)", async () => {
    const fx = await account();
    const key = grantKey();
    const body = grantBody(fx);
    const first = applied(await postGrant(suite, fx, key, body));

    const again = await call(suite.baseUrl, grantPath(fx.userId), {
      rawBody: JSON.stringify({
        expectedPersonalStudioId: body.expectedPersonalStudioId,
        reason: body.reason,
        credits: body.credits,
        kind: body.kind,
      }),
      idempotencyKey: key,
      admin: GRANT_ADMIN,
    });

    expect(applied(again)).toEqual(first);
    expect(await fundingState(suite.sql, fx)).toMatchObject({ sources: 1, lots: 1, operations: 1 });
  });
});

// Acceptance #6 refuses a key reused with another method. The grant write is
// POST only, so another method never reaches the key lookup: the
// authorisation table answers 403 first.
describe("same key, another method: never reaches a write", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE"])(
    "an applied grant's key sent with %s to the same path is 403 forbidden and changes nothing",
    async (method) => {
      const fx = await account();
      const key = grantKey();
      applied(await postGrant(suite, fx, key));
      const after = await fundingState(suite.sql, fx);

      // `call` types only the methods the table uses; any other is signed the same way.
      const res = await call(suite.baseUrl, grantPath(fx.userId), {
        method: method as "POST",
        ...(method === "GET" ? {} : { body: grantBody(fx) }),
        idempotencyKey: key,
        admin: GRANT_ADMIN,
      });

      expect(res.status).toBe(403);
      expect(res.json).toEqual({ code: "forbidden" });
      expect(await fundingState(suite.sql, fx)).toEqual(after);
      expect(await holdersOf(key)).toEqual([fx.userId]);
    },
  );
});

describe("a stored refusal owns its key and prevalidation leaves it free", () => {
  it("after a refusal is stored, another account under the same key is a conflict and is not funded", async () => {
    const fx = await account();
    const other = await account();
    const key = grantKey();

    const refused = await postGrant(suite, fx, key, grantBody(fx, { expectedPersonalStudioId: other.studioId }));
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ status: "refused", code: "personal_studio_changed" });

    expectConflict(await postGrant(suite, other, key));
    expect(await fundingState(suite.sql, other)).toMatchObject({ sources: 0, lots: 0, operations: 0 });
    expect(await holdersOf(key)).toEqual([fx.userId]);
  });

  it("after a 422 the same key runs a valid request", async () => {
    const fx = await account();
    const key = grantKey();

    const invalid = await postGrant(suite, fx, key, grantBody(fx, { reason: "" }));
    expect(invalid.status).toBe(422);
    expect(await holdersOf(key)).toEqual([]);

    applied(await postGrant(suite, fx, key));
    expect(await holdersOf(key)).toEqual([fx.userId]);
  });
});

describe("one key, two accounts, at the same time (§9)", () => {
  it("exactly one grant runs; the other is 409 idempotency_conflict and its account is not funded", async () => {
    const a = await account();
    const b = await account();
    const key = grantKey();

    const answers = await Promise.all([postGrant(suite, a, key), postGrant(suite, b, key)]);

    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = applied(answers.find((r) => r.status === 200)!);
    expectConflict(answers.find((r) => r.status === 409)!);
    const [winnerAccount, loserAccount] = winner.operation.accountId === a.userId ? [a, b] : [b, a];
    expect(await fundingState(suite.sql, winnerAccount)).toMatchObject({ sources: 1, lots: 1, operations: 1 });
    expect(await fundingState(suite.sql, loserAccount)).toMatchObject({ sources: 0, lots: 0, operations: 0 });
    expect(await holdersOf(key)).toEqual([winnerAccount.userId]);
  });
});
