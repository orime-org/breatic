// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 存储配额闸门（#89，会员块五）—— real-PG 集成。
 *
 * 判据只有一条：该 studio 的 admin 的档位存储上限，减去那个 admin 的账号总
 * 用量，剩下的大于 0 就放行。不看这一次要写多大，不冻结、不预留 —— 所以存储
 * 会超限，那是拍过板的接受结果。
 *
 * 这里钉的四件事，每一条都对应一种「写起来很自然、但判错了对象」的实现：
 *
 *   1. 判的是 admin，不是操作者。团队里 editor 上传时字节进团队池，判的是
 *      admin 的账号总量 —— editor 自己的个人 studio 装得多满都不算数。
 *   2. 用量是账号跨 studio 求和，不是这一个 studio 的字节。只数当前这个
 *      studio 的实现，在「admin 的个人 studio 快满、要写的团队 studio 是空
 *      的」这个场景下会放行，而账号早就满了。
 *   3. 上限经 honouredTier。欠费超过宽限窗口的 pro 账号按 base 判，不然
 *      别的上限按 base、存储按 pro，同一个账号两套标准。
 *   4. 企业档放行，且 limitBytes 是 null —— 不是编一个数，也不是 500。
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  inject,
  vi,
} from "vitest";

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

// 四个替身，用来观察通知那一段并让它逐段失败。拒绝本身是承诺内的行为，
// 通知是它的附加动作 —— 附加动作炸了不许把 507 变成 500。
// 每个替身对应一段：邮件工厂（mailCtl）· 铃铛插入（bellCtl）· 窗口认领
// （throttleCtl）· 邮件要用的那次 studio 读（studioReadCtl）。
// 邮件的**发送**失败不在这里 —— 那一层自己吞掉，由它自己的单测钉住。
const sentMail = vi.fn();
const mailCtl = { failFactory: false };

// 这个替身照着真实的 sendBestEffortMail 写：**它吞掉一切、永不抛**
// （`send-best-effort-mail.ts:40-45` 把准备和发送整个包在 try/catch 里）。
// 让替身会抛，测出来的就只是替身自己 —— 而生产里铃铛落库之后没有任何东西
// 能从这个边界里冒出来，下面那条「窗口不许被还回去」正是钉这件事。
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async (
    build: () => Promise<unknown>,
    ctx: Record<string, unknown>,
  ) => {
    try {
      if (mailCtl.failFactory) throw new Error("synthetic factory failure");
      const mail = await build();
      // 真实那层在这里短路：`if (!mail) return;` —— 工厂说「别发」时既不
      // 发信也不记结果。替身漏掉这一句的话，一个恒返回 null 的工厂在测试
      // 里看起来跟正常发信一模一样。
      if (!mail) return;
      sentMail(mail, ctx);
    } catch {
      // 跟真的一样：吞掉，不影响调用方。
    }
  },
}));

const bellCtl = { fail: false };

vi.mock("@server/modules/notification/notification.service.js", async (io) => {
  const actual = await io<Record<string, unknown>>();
  return {
    ...actual,
    createStorageQuotaExceeded: async (input: unknown) => {
      if (bellCtl.fail) throw new Error("synthetic bell failure");
      return (
        actual.createStorageQuotaExceeded as (i: unknown) => Promise<unknown>
      )(input);
    },
  };
});

// 记下每一次全账号求和，好断言企业档那条路根本没走到它。
const usageCalls: string[] = [];

vi.mock("@server/modules/asset/assetUsage.service.js", async (io) => {
  const actual = await io<Record<string, unknown>>();
  return {
    ...actual,
    accountStorageUsage: async (userId: string) => {
      usageCalls.push(userId);
      return (actual.accountStorageUsage as (u: string) => Promise<number>)(
        userId,
      );
    },
  };
});

// 取 studio 名字那次读只有邮件用得上。它在不在 best-effort 边界里面，决定了
// 它抛错时铃铛那一行会不会连累窗口被还回去。
const studioReadCtl = { fail: false };

vi.mock("@server/modules/studio/studio.repo.js", async (io) => {
  const actual = await io<Record<string, unknown>>();
  return {
    ...actual,
    getById: async (id: string, tx?: unknown) => {
      if (studioReadCtl.fail) throw new Error("synthetic studio read failure");
      return (actual.getById as (i: string, t?: unknown) => Promise<unknown>)(
        id,
        tx,
      );
    },
  };
});

const throttleCtl = { fail: false };

vi.mock("@server/modules/asset/storage-notice-throttle.js", async (io) => {
  const actual = await io<Record<string, unknown>>();
  return {
    ...actual,
    claimNoticeWindow: async (adminUserId: string) => {
      if (throttleCtl.fail) throw new Error("synthetic redis failure");
      return (actual.claimNoticeWindow as (a: string) => Promise<boolean>)(
        adminUserId,
      );
    },
  };
});

const logged: { line: string; ctx: Record<string, unknown> }[] = [];

vi.mock("@breatic/core", async (io) => {
  const orig = await io<Record<string, unknown>>();
  const real = orig.logger as Record<string, (...a: unknown[]) => void>;
  return {
    ...orig,
    // 转发而不是展开：pino 的方法挂在原型上，`{ ...real }` 只拿得到自有属性，
    // 于是 `logger.error` 会是 undefined —— 而生产代码里正是靠它兜住通知那
    // 一段的失败，替身缺了它，测试就在测替身自己。
    logger: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === "info") {
            return (ctx: Record<string, unknown>, line: string) => {
              logged.push({ line, ctx });
              real.info?.(ctx, line);
            };
          }
          const value = real[prop];
          return typeof value === "function" ? value.bind(real) : value;
        },
      },
    ),
  };
});

import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, loadLocales, getMembershipLimits } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "storage-quota-test" },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user on a given tier, plus their personal studio.
 * @param tier - The membership tier to stamp on the account.
 * @returns The user id and their personal studio id.
 */
async function insertUser(
  tier: string,
): Promise<{ userId: string; personalStudioId: string }> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`sq-${seq++}@example.test`}, true, ${tier})
    RETURNING id
  `;
  const userId = u!.id;
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`sq-p-${seq++}`}, 'personal', 'Personal')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${userId}, 'admin')
  `;
  return { userId, personalStudioId: st!.id };
}

/**
 * A team studio whose current admin is `adminUserId`.
 * @param adminUserId - Who administers it.
 * @returns The studio id.
 */
async function insertTeamStudio(adminUserId: string): Promise<string> {
  const [st] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${`sq-t-${seq++}`}, 'team', 'Team')
    RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${st!.id}, ${adminUserId}, 'admin')
  `;
  return st!.id;
}

/**
 * A project inside a studio.
 * @param studioId - The studio that owns it.
 * @param createdBy - Whoever created it; not what decides the ceilings.
 * @returns The project id.
 */
async function insertProject(
  studioId: string,
  createdBy: string,
): Promise<string> {
  const [p] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${createdBy}, 'Project', ${`sq-pr-${seq++}`})
    RETURNING id
  `;
  return p!.id;
}

/**
 * Put `sizeBytes` of registered asset into a studio.
 * @param studioId - Which studio's pool the bytes land in.
 * @param producedBy - The account on the asset row's FK.
 * @param sizeBytes - How many bytes to register.
 */
async function seedAsset(
  studioId: string,
  producedBy: string,
  sizeBytes: number,
): Promise<void> {
  await assetRepo.registerWithDedup({
    studioId,
    producedByUserId: producedBy,
    contentHash: crypto.randomBytes(32).toString("hex"),
    storageKey: `image/2026-08-19/${crypto.randomUUID()}.png`,
    fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
    sizeBytes,
    mimeType: "image/png",
    kind: "image",
    source: "upload",
  });
}

const BASE_STORAGE = getMembershipLimits("base").storage_bytes;
const PRO_STORAGE = getMembershipLimits("pro").storage_bytes;

describe("assertStorageAllowance", () => {
  it("lets a write through while there is room", async () => {
    // 它不回答「还剩多少」—— 那是另一个问题、另一批读者（#120 的属性页）。
    // 这里能观察到的只有「过了」和「没过」，而这正是调用方需要知道的全部。
    const { userId, personalStudioId } = await insertUser("base");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, 1024);

    await expect(
      assertStorageAllowance(projectId, "upload"),
    ).resolves.toBeUndefined();
  });

  it("refuses with 507 once the account is at its ceiling", async () => {
    const { userId, personalStudioId } = await insertUser("base");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, BASE_STORAGE);

    // Exactly at the ceiling is already refused: the rule is "more than zero
    // left", so zero left is full (user 2026-08-19).
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("judges the studio's admin, not whoever is uploading", async () => {
    // An editor whose OWN personal studio is over their own ceiling uploads
    // into a team studio with room. The bytes land in the team pool, so the
    // team admin's account is what decides — the editor's full personal
    // studio has nothing to do with it.
    const admin = await insertUser("pro");
    const editor = await insertUser("base");
    const teamStudioId = await insertTeamStudio(admin.userId);
    await sql`
      INSERT INTO studio_members (studio_id, user_id, role)
      VALUES (${teamStudioId}, ${editor.userId}, 'maintainer')
    `;
    const projectId = await insertProject(teamStudioId, admin.userId);
    await seedAsset(editor.personalStudioId, editor.userId, BASE_STORAGE);

    // 判操作者的话这里会抛：editor 自己那份正好压满 base 的上限。
    await expect(
      assertStorageAllowance(projectId, "upload"),
    ).resolves.toBeUndefined();
  });

  it("sums the admin's whole account, not just the studio being written to", async () => {
    // The case that tells "account roll-up" apart from "this studio's bytes":
    // the admin's PERSONAL studio is full, the team studio being written to is
    // empty. An implementation that counted only the target studio would let
    // this through while the account is long past its ceiling.
    const admin = await insertUser("base");
    const teamStudioId = await insertTeamStudio(admin.userId);
    const projectId = await insertProject(teamStudioId, admin.userId);
    await seedAsset(admin.personalStudioId, admin.userId, BASE_STORAGE);

    await expect(assertStorageAllowance(projectId, "generate")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("holds a lapsed pro subscription to the base ceiling", async () => {
    // Every other ceiling already honours a subscription that stopped paying
    // long enough ago. Storage must not be the one that keeps the pro number.
    const { userId, personalStudioId } = await insertUser("pro");
    const projectId = await insertProject(personalStudioId, userId);
    await sql`
      INSERT INTO subscriptions (
        user_id, stripe_subscription_id, tier, status, current_period_end
      )
      VALUES (
        ${userId}, ${`sub_${seq++}`}, 'pro',
        'active', now() - interval '400 days'
      )
    `;
    // Between the two ceilings, so it passes on pro's and fails on base's —
    // the assertion cannot be satisfied by either number alone.
    await seedAsset(personalStudioId, userId, BASE_STORAGE + 1);

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject({
      statusCode: 507,
    });
  });

  it("does not measure an account it has no ceiling to compare against", async () => {
    // 企业档没有可比的上限，那次跨 studio 的求和就没人会读 —— 早返回排在它
    // 之前。把顺序换回去这条会红（那次求和会真的发生）。
    const { userId, personalStudioId } = await insertUser("enterprise");
    const projectId = await insertProject(personalStudioId, userId);
    const before = usageCalls.length;

    await assertStorageAllowance(projectId, "upload");

    expect(usageCalls.length).toBe(before);
  });

  it("lets the enterprise tier through however much it holds", async () => {
    // 同样的用量在任何一个配置了上限的档位上都会被拒。「上限是 null 而不是
    // 编出来的数」由 membership-tier-lookup 那套直接钉在 getStudioStorageQuota
    // 上，这里钉的是产品规则本身：企业档放行。
    const { userId, personalStudioId } = await insertUser("enterprise");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, PRO_STORAGE * 10);

    await expect(
      assertStorageAllowance(projectId, "generate"),
    ).resolves.toBeUndefined();
  });
});

describe("assertStorageAllowance — telling the admin", () => {
  beforeEach(() => {
    sentMail.mockClear();
    logged.length = 0;
    mailCtl.failFactory = false;
    bellCtl.fail = false;
    throttleCtl.fail = false;
    studioReadCtl.fail = false;
  });

  /**
   * An account already past its ceiling, with a project to write into.
   * @returns The admin id, their studio, and a project in it.
   */
  async function fullAccount(): Promise<{
    adminUserId: string;
    adminEmail: string;
    studioId: string;
    studioName: string;
    projectId: string;
  }> {
    const { userId, personalStudioId } = await insertUser("base");
    const projectId = await insertProject(personalStudioId, userId);
    await seedAsset(personalStudioId, userId, BASE_STORAGE);
    const [row] = await sql<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${userId}
    `;
    return {
      adminUserId: userId,
      adminEmail: row!.email,
      studioId: personalStudioId,
      studioName: "Personal",
      projectId,
    };
  }

  /**
   * The storage notifications sitting in an account's bell.
   * @param userId - Whose inbox to read.
   * @returns One row per notification, payload parsed.
   */
  async function bellRows(
    userId: string,
  ): Promise<{ payload: Record<string, unknown> }[]> {
    return sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM notifications
      WHERE user_id = ${userId} AND type = 'storage.quota_exceeded'
    `;
  }

  it("puts a row in the admin's bell and sends the mail", async () => {
    const { adminUserId, adminEmail, studioId, studioName, projectId } =
      await fullAccount();

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject(
      { statusCode: 507 },
    );

    const rows = await bellRows(adminUserId);
    expect(rows).toHaveLength(1);
    // The row records WHERE it happened. The line the admin reads says only
    // that storage is full, because what is full is the account.
    expect(rows[0]!.payload).toEqual({ studioId });
    // 断言信本身，不只是「发过一次」：只数次数的话，工厂返回 null、或者
    // 把信寄给别人，测试照样绿。
    expect(sentMail).toHaveBeenCalledTimes(1);
    const [mail] = sentMail.mock.calls[0] as [
      { to: string; subject: string; html: string },
    ];
    expect(mail.to).toBe(adminEmail);
    expect(mail.subject).toContain("storage is full");
    expect(mail.html).toContain(studioName);
  });

  it("sends one notice per account per window, not one per studio", async () => {
    // The case that tells an account-keyed window apart from a studio-keyed
    // one: one admin, two studios, one refusal in each. Keyed by studio this
    // would send twice — and the second would name a studio that is nearly
    // empty, since what is full is the account.
    const { userId, personalStudioId } = await insertUser("base");
    const otherStudioId = await insertTeamStudio(userId);
    const projectA = await insertProject(personalStudioId, userId);
    const projectB = await insertProject(otherStudioId, userId);
    await seedAsset(personalStudioId, userId, BASE_STORAGE);

    await expect(assertStorageAllowance(projectA, "upload")).rejects.toThrow();
    await expect(assertStorageAllowance(projectB, "generate")).rejects.toThrow();

    expect(await bellRows(userId)).toHaveLength(1);
    expect(sentMail).toHaveBeenCalledTimes(1);
  });

  it("logs every refusal, including the ones the window silences", async () => {
    // The bell is for the admin and is deliberately quietened. The log is for
    // whoever is on call, and must not be — otherwise "how often did this gate
    // fire today" has no answer after the first hit of each window.
    const { adminUserId, projectId } = await fullAccount();

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();

    const lines = logged.filter((l) => l.line === "storage_quota_exceeded");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.ctx).toMatchObject({ adminUserId, purpose: "upload" });
    expect(await bellRows(adminUserId)).toHaveLength(1);
  });

  it("sends nothing when the mail factory refuses, and keeps the refusal", async () => {
    // 工厂抛错是真实那层唯一会自己吞掉的一类失败（准备阶段的读挂了）。
    // 它既不该发信，也不该动到拒绝本身。
    const { adminUserId, projectId } = await fullAccount();
    mailCtl.failFactory = true;

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject(
      { statusCode: 507 },
    );
    expect(sentMail).not.toHaveBeenCalled();
    expect(await bellRows(adminUserId)).toHaveLength(1);
  });

  it("still refuses with 507 when the bell insert throws", async () => {
    const { projectId } = await fullAccount();
    bellCtl.fail = true;
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject(
      { statusCode: 507 },
    );
  });

  it("keeps the window once the bell row is in, even if the mail's own reads fail", async () => {
    // 上一轮把「没发出去就把窗口还回来」加进来之后，取 studio 名字那次读还在
    // best-effort 边界外面、排在铃铛插入之后 —— 它一抛错，一个「已经通知过」
    // 的窗口就被还了回去，同一窗口内的下一次拒绝会再写一行铃铛。
    // 现在邮件要的东西全在边界里面读，所以铃铛落库之后没有任何东西能把窗口
    // 拿走：第二次拒绝仍然静默。
    const { adminUserId, projectId } = await fullAccount();

    studioReadCtl.fail = true;
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();
    expect(await bellRows(adminUserId)).toHaveLength(1);

    studioReadCtl.fail = false;
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();
    expect(await bellRows(adminUserId)).toHaveLength(1);
  });

  it("gives the window back when the notice did not go out", async () => {
    // Found on a real machine: the window is claimed BEFORE anything is sent,
    // and it means "this account has been told". The first attempt failed on
    // the bell insert, so nobody was told — and without giving the slot back,
    // the next refusal is silenced too and an account that is still full goes
    // a whole window unmentioned.
    const { adminUserId, projectId } = await fullAccount();

    bellCtl.fail = true;
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();
    expect(await bellRows(adminUserId)).toHaveLength(0);

    bellCtl.fail = false;
    await expect(assertStorageAllowance(projectId, "upload")).rejects.toThrow();
    expect(await bellRows(adminUserId)).toHaveLength(1);
  });

  it("still refuses with 507, and still notifies, when Redis throws", async () => {
    // The window claim is what decides whether to notify. Redis being down
    // must not swallow the notice — better a duplicate bell row than silence
    // about a full account.
    const { adminUserId, projectId } = await fullAccount();
    throttleCtl.fail = true;

    await expect(assertStorageAllowance(projectId, "upload")).rejects.toMatchObject(
      { statusCode: 507 },
    );
    expect(await bellRows(adminUserId)).toHaveLength(1);
  });
});
