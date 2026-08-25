// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 失去 admin 身份即解除积分包指定（任务 #15），钉在真实 Postgres 上。
 *
 * 规则：一个人不再是某 studio 的 admin 的那一瞬间，他名下指向这个 studio 的
 * 每一笔积分，`designated_studio_id` 当场清空。今天唯一能让 admin 不再是 admin
 * 的路径是转让被接受（`confirmTransfer`），所以这一族全部从那里驱动。
 *
 * 这里的不变量都是 SQL 层的，mock 出来的查询构造器复现不了：
 *
 *   - 清空与降级同生共死（同一个事务，中途读不到半截状态）。
 *   - 只清这个人的、只清仍然指着这个 studio 的。
 *   - 两本账一分不改：剩余额度、流水行数、欠账都不动。
 *   - 转让被拒绝、降级没跑时，一笔都不许清。
 *   - 清空之后同一个人不能再把一笔指回来 —— 角色判定必须在事务内持锁读。
 *   - 新增的那条跨表加锁顺序不产生循环等待。
 *
 * 并发那几条用 `lock-probe.ts` 把交错强制出来，不用 `Promise.allSettled` 碰运气。
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import { initCore } from "@breatic/core";
import { creditLotService, studioMembersRepo } from "@breatic/domain";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";

import { waitUntilBlockedOn } from "./lock-probe.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;
/** A second pool, so a test can hold a lock while the code under test runs. */
let holder: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "release-designations-test" },
  });
  holder = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "release-designations-holder" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await holder?.end({ timeout: 1 });
});

let seq = 0;

/** Insert a user; returns its id. */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`rd-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

/** Give a user a personal studio — the outcome notification reads its name. */
async function insertPersonalStudio(userId: string): Promise<void> {
  await sql`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`rd-personal-${seq++}`}, 'personal', 'Person')
  `;
}

/** Insert a team studio plus the creator's admin row. */
async function insertStudioWithAdmin(
  adminUserId: string,
): Promise<{ id: string; slug: string }> {
  const slug = `rd-studio-${seq++}`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, 'team', 'Release Studio')
    RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${id}, ${adminUserId}, 'admin')
  `;
  return { id, slug };
}

/** Add an active member row directly. */
async function insertMemberRaw(
  studioId: string,
  userId: string,
  role: "admin" | "maintainer" | "guest",
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${role})
  `;
}

/**
 * Open a lot through the real grant path, then point it somewhere.
 *
 * The designation is set with raw SQL rather than through `designateLot`,
 * because that call would repay any debt the studio carries — which is exactly
 * what the two-books test needs to stay out of its setup.
 */
async function insertLot(
  userId: string,
  studioId: string | null,
  credits = 500,
): Promise<string> {
  const [payment] = await sql<{ id: string }[]>`
    INSERT INTO payments (user_id, amount_cents, status, credits_granted)
    VALUES (${userId}, 1000, 'completed', ${credits}) RETURNING id
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: payment!.id,
    userId,
    purchasedCredits: credits,
  });
  if (studioId !== null) {
    await sql`
      UPDATE credit_lots SET designated_studio_id = ${studioId} WHERE id = ${lot.id}
    `;
  }
  return lot.id;
}

/** Where a lot points right now. */
async function designationOf(lotId: string): Promise<string | null> {
  const [row] = await sql<{ designated_studio_id: string | null }[]>`
    SELECT designated_studio_id FROM credit_lots WHERE id = ${lotId}
  `;
  return row!.designated_studio_id;
}

/** A lot's remaining balance, as the exact numeric text. */
async function remainingOf(lotId: string): Promise<string> {
  const [row] = await sql<{ remaining_credits: string }[]>`
    SELECT remaining_credits FROM credit_lots WHERE id = ${lotId}
  `;
  return row!.remaining_credits;
}

/** How many ledger rows exist for one account. */
async function ledgerCount(userId: string): Promise<number> {
  const [row] = await sql<{ c: number }[]>`
    SELECT count(*)::int AS c FROM credit_ledger WHERE payer_user_id = ${userId}
  `;
  return row!.c;
}

/** What a studio owes, as stored; null when it has no debt row. */
async function debtOf(studioId: string): Promise<string | null> {
  const [row] = await sql<{ amount: string }[]>`
    SELECT amount FROM studio_credit_debts WHERE studio_id = ${studioId}
  `;
  return row ? row.amount : null;
}

/**
 * The SQLSTATE of a rejected query, when it has one.
 *
 * The chain is walked rather than the top level read, for the reason
 * `utils/pg-error.ts` already documents: a query made through drizzle arrives
 * as a `DrizzleQueryError` whose own `code` is undefined and whose SQLSTATE
 * sits on `.cause`, so a flat check reports null while a deadlock is happening.
 * @param err - Whatever was thrown or rejected with.
 * @returns The first SQLSTATE found on the error or its causes, else null.
 */
function sqlStateOf(err: unknown): string | null {
  let current: unknown = err;
  // Bounded so a cyclic cause chain cannot spin here.
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== "object") return null;
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    if (!("cause" in current)) return null;
    current = current.cause;
  }
  return null;
}

/** Postgres' SQLSTATE for a deadlock it broke by aborting somebody. */
const DEADLOCK = "40P01";

interface Seeded {
  studioId: string;
  slug: string;
  /** The current admin, who will lose the studio. */
  adminId: string;
  /** The recipient, who will become admin. */
  memberId: string;
}

/** A team studio with an admin and one maintainer, both with personal studios. */
async function seedStudio(): Promise<Seeded> {
  const adminId = await insertUser();
  const memberId = await insertUser();
  await insertPersonalStudio(adminId);
  await insertPersonalStudio(memberId);
  const studio = await insertStudioWithAdmin(adminId);
  await insertMemberRaw(studio.id, memberId, "maintainer");
  return { studioId: studio.id, slug: studio.slug, adminId, memberId };
}

/** Seed a studio and put a transfer offer on the table; returns its id too. */
async function seedPendingTransfer(): Promise<Seeded & { transferId: string }> {
  const seeded = await seedStudio();
  await studioTransferService.requestTransfer(
    seeded.slug,
    seeded.adminId,
    seeded.memberId,
  );
  const [req] = await sql<{ transfer_id: string }[]>`
    SELECT payload->>'transferId' AS transfer_id FROM notifications
    WHERE user_id = ${seeded.memberId} AND type = 'studio.transfer_request'
      AND deleted_at IS NULL
    ORDER BY created_at DESC
  `;
  return { ...seeded, transferId: req!.transfer_id };
}

describe("a transfer takes the admin away and the designations go with it", () => {
  it("clears every lot of the outgoing admin that pointed at this studio", async () => {
    const s = await seedPendingTransfer();
    const first = await insertLot(s.adminId, s.studioId);
    const second = await insertLot(s.adminId, s.studioId);

    await studioTransferService.confirmTransfer(s.transferId, s.memberId);

    expect(await studioMembersRepo.getRole(s.studioId, s.adminId)).toBe(
      "maintainer",
    );
    expect(await designationOf(first)).toBeNull();
    expect(await designationOf(second)).toBeNull();
  });

  it("leaves a lot of theirs pointed at another studio alone", async () => {
    const s = await seedPendingTransfer();
    const elsewhere = await insertStudioWithAdmin(s.adminId);
    const here = await insertLot(s.adminId, s.studioId);
    const there = await insertLot(s.adminId, elsewhere.id);

    await studioTransferService.confirmTransfer(s.transferId, s.memberId);

    expect(await designationOf(here)).toBeNull();
    expect(await designationOf(there)).toBe(elsewhere.id);
  });

  it("completes when the outgoing admin holds no lot here", async () => {
    const s = await seedPendingTransfer();

    await expect(
      studioTransferService.confirmTransfer(s.transferId, s.memberId),
    ).resolves.toBeUndefined();

    expect(await studioMembersRepo.getRole(s.studioId, s.memberId)).toBe("admin");
  });

  it("leaves another account's lot pointed where it was", async () => {
    // Only an admin may designate, and a studio has one at a time, so this
    // state only reaches production as history: a transfer that happened
    // before this rule existed. It is seeded directly for that reason.
    const s = await seedPendingTransfer();
    const outsider = await insertUser();
    const mine = await insertLot(s.adminId, s.studioId);
    const theirs = await insertLot(outsider, s.studioId);

    await studioTransferService.confirmTransfer(s.transferId, s.memberId);

    expect(await designationOf(mine)).toBeNull();
    expect(await designationOf(theirs)).toBe(s.studioId);
  });

  it("rewrites neither book", async () => {
    const s = await seedPendingTransfer();
    const lot = await insertLot(s.adminId, s.studioId, 500);
    // A debt on the studio, so the "did anything repay it" question has an
    // answer to be wrong about.
    await sql`
      INSERT INTO studio_credit_debts (studio_id, amount) VALUES (${s.studioId}, 120)
    `;
    const remainingBefore = await remainingOf(lot);
    const ledgerBefore = await ledgerCount(s.adminId);

    await studioTransferService.confirmTransfer(s.transferId, s.memberId);

    expect(await remainingOf(lot)).toBe(remainingBefore);
    expect(await ledgerCount(s.adminId)).toBe(ledgerBefore);
    expect(await debtOf(s.studioId)).toBe("120.000000");
  });

  it("clears nothing when the transfer is refused before the demote", async () => {
    // The recipient was demoted to guest after the offer went out, so confirm
    // takes the refusal branch that returns before the demote — and returning
    // commits the transaction, so a release placed above that branch would
    // strip an admin who never stopped being one.
    const s = await seedPendingTransfer();
    const lot = await insertLot(s.adminId, s.studioId);
    await sql`
      UPDATE studio_members SET role = 'guest'
      WHERE studio_id = ${s.studioId} AND user_id = ${s.memberId}
    `;

    await expect(
      studioTransferService.confirmTransfer(s.transferId, s.memberId),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(await studioMembersRepo.getRole(s.studioId, s.adminId)).toBe("admin");
    expect(await designationOf(lot)).toBe(s.studioId);
  });

  it("skips a lot that moved to another studio while its lock was waited for", async () => {
    // Two lots, oldest first. A held lock on the second parks the release
    // between listing and locking; the first is already clear by then, and the
    // second moves elsewhere in that window. The row the lock hands back is
    // what decides, so the moved one must survive.
    const s = await seedPendingTransfer();
    const elsewhere = await insertStudioWithAdmin(s.adminId);
    const first = await insertLot(s.adminId, s.studioId);
    const second = await insertLot(s.adminId, s.studioId);

    let transfer: Promise<void>;
    await holder.begin(async (tx) => {
      // The older lot is the one the release reaches first, so holding it
      // parks the release with the younger one still unread.
      await tx`SELECT id FROM credit_lots WHERE id = ${first} FOR UPDATE`;

      transfer = studioTransferService.confirmTransfer(
        s.transferId,
        s.memberId,
      );
      await waitUntilBlockedOn(sql, ["credit_lots", "for update"]);

      await sql`
        UPDATE credit_lots SET designated_studio_id = ${elsewhere.id}
        WHERE id = ${second}
      `;
    });
    await transfer!;

    expect(await designationOf(first)).toBeNull();
    expect(await designationOf(second)).toBe(elsewhere.id);
  });

  it("refuses a designation issued after the transfer committed", async () => {
    const s = await seedPendingTransfer();
    const lot = await insertLot(s.adminId, null);

    await studioTransferService.confirmTransfer(s.transferId, s.memberId);

    await expect(
      creditLotService.designateLot({
        lotId: lot,
        requestingUserId: s.adminId,
        studioId: s.studioId,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await designationOf(lot)).toBeNull();
  });

  it("parks the designation on the membership row", async () => {
    // The role check has to run inside the transaction, holding the member
    // row — a check made outside it answers about a moment already gone by the
    // time the write lands. Holding that row here is what makes the difference
    // observable: with the check outside, nothing ever parks on studio_members.
    const s = await seedStudio();
    const lot = await insertLot(s.adminId, null);

    let designating: Promise<unknown>;
    await holder.begin(async (tx) => {
      await tx`
        SELECT user_id FROM studio_members
        WHERE studio_id = ${s.studioId} FOR UPDATE
      `;

      designating = creditLotService.designateLot({
        lotId: lot,
        requestingUserId: s.adminId,
        studioId: s.studioId,
      });
      await waitUntilBlockedOn(sql, ["studio_members", "for update"]);
    });
    await designating!;

    expect(await designationOf(lot)).toBe(s.studioId);
  });

  it("takes its locks in the order a charge takes them", async () => {
    // The release runs inside the transfer, which already holds every
    // membership row; a designation on the same studio wants that row too and
    // queues behind it. Neither side ever holds one of the two and waits on
    // the other, so nothing here can deadlock.
    const s = await seedPendingTransfer();
    const held = await insertLot(s.adminId, s.studioId);
    const loose = await insertLot(s.adminId, null);

    let transfer: Promise<void>;
    let designating: Promise<unknown>;
    await holder.begin(async (tx) => {
      await tx`SELECT id FROM credit_lots WHERE id = ${held} FOR UPDATE`;

      transfer = studioTransferService.confirmTransfer(
        s.transferId,
        s.memberId,
      );
      await waitUntilBlockedOn(sql, ["credit_lots", "for update"]);

      designating = creditLotService
        .designateLot({
          lotId: loose,
          requestingUserId: s.adminId,
          studioId: s.studioId,
        })
        .then(
          () => "designated" as const,
          (err: unknown) => err,
        );
      await waitUntilBlockedOn(sql, ["studio_members", "for update"]);
    });

    const transferError = await transfer!.then(
      () => null,
      (err: unknown) => err,
    );
    const outcome = await designating!;

    // Neither side may have been aborted by the deadlock detector.
    expect(sqlStateOf(transferError)).not.toBe(DEADLOCK);
    expect(sqlStateOf(outcome)).not.toBe(DEADLOCK);
    expect(transferError).toBeNull();
    // The designation queued behind the transfer, so by the time it read the
    // role it was no longer the admin's to give.
    expect(outcome).toMatchObject({ statusCode: 403 });
    expect(await designationOf(held)).toBeNull();
    expect(await designationOf(loose)).toBeNull();
  });

  it("keeps the clearing and the demote in one transaction", async () => {
    // Parked on the settle write, the transfer has already demoted and
    // cleared but committed nothing. A reader on another connection must
    // still see both old values; seeing a cleared lot next to an unchanged
    // role would mean the clearing had committed on its own.
    const s = await seedPendingTransfer();
    const lot = await insertLot(s.adminId, s.studioId);

    let transfer: Promise<void>;
    await holder.begin(async (tx) => {
      await tx`
        SELECT id FROM studio_transfers WHERE id = ${s.transferId} FOR UPDATE
      `;

      transfer = studioTransferService.confirmTransfer(
        s.transferId,
        s.memberId,
      );
      await waitUntilBlockedOn(sql, ["studio_transfers", "for update"]);

      expect(await designationOf(lot)).toBe(s.studioId);
      expect(await studioMembersRepo.getRole(s.studioId, s.adminId)).toBe(
        "admin",
      );
    });
    await transfer!;

    expect(await designationOf(lot)).toBeNull();
    expect(await studioMembersRepo.getRole(s.studioId, s.adminId)).toBe(
      "maintainer",
    );
  });
});
