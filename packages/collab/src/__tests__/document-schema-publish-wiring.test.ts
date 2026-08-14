// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 发布这件事**真的接上了**（验收 10 的接线那一半）。
 *
 * `document-schema-publisher.test.ts` 测的是「调了它会怎样」；这里测的是
 * 「`hocuspocus.ts` 到底会不会为一个 meta 文档调它」。两者缺一不可 —— 接线
 * 断了的话，前端永远收不到服务器那份清单，条件一从此不会成立一次，而没有
 * 任何东西会报错。
 *
 * 做法：把 `Server` 换成一个只记下配置的替身，从记下的配置里取出真正的
 * `afterLoadDocument`，拿一份真的 Yjs 文档去调它。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  DOCUMENT_SCHEMA,
  DOCUMENT_SCHEMA_META_KEY,
  projectMetaDocName,
  spaceContentDocName,
} from "@breatic/shared";

const { serverSpy, loggerSpy } = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  loggerSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@hocuspocus/extension-redis", () => ({
  Redis: class {
    constructor() {
      /* 这条测试不碰跨实例的那一半。 */
    }
  },
}));

vi.mock("@hocuspocus/server", () => ({
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@breatic/core", () => ({
  createLogger: () => loggerSpy,
  createRedisClient: vi.fn(() => ({ on: vi.fn() })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  MONOREPO_ROOT: "/tmp",
}));

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    count: vi.fn(async () => 0),
  })),
}));

vi.mock("@collab/services/handling-sweeper.js", () => ({
  createHandlingSweeper: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  scheduleLoadSweep: vi.fn(),
  resolveLeaseBudget: vi.fn(() => 3_600_000),
}));

import { createCollabServer } from "../hocuspocus.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-9222-222222222222";

type LoadHook = (payload: {
  documentName: string;
  document: Y.Doc;
  instance: { documents: Map<string, unknown> };
}) => Promise<void>;

/**
 * 起一次服务器，把它真正挂上去的那个加载钩子取出来。
 * @returns 真正的 `afterLoadDocument`。
 */
async function loadHook(): Promise<LoadHook> {
  serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 1234,
    redisKeyPrefix: "test",
  });
  const config = serverSpy.mock.calls[0]?.[0] as {
    afterLoadDocument?: LoadHook;
  };
  const hook = config.afterLoadDocument;
  if (!hook) throw new Error("afterLoadDocument 根本没有挂上去");
  return hook;
}

/**
 * 读文档里发布出来的那份清单。
 * @param doc - 被检查的文档。
 * @returns 那个键下的内容。
 */
function published(doc: Y.Doc): Record<string, unknown> {
  return doc.getMap(DOCUMENT_SCHEMA_META_KEY).toJSON();
}

describe("meta 文档加载时", () => {
  let hook: LoadHook;

  beforeEach(async () => {
    loggerSpy.error.mockClear();
    hook = await loadHook();
  });

  it("这一版的 schema 被写进去了", async () => {
    const doc = new Y.Doc();

    await hook({
      documentName: projectMetaDocName(PID),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc).nodes).toEqual(DOCUMENT_SCHEMA.nodes);
    expect(published(doc).marks).toEqual(DOCUMENT_SCHEMA.marks);
    expect(typeof published(doc).publishedAt).toBe("string");
    doc.destroy();
  });

  it("第二次加载不重写 —— 时间戳说的是「什么时候变的」，不是「什么时候被打开的」", async () => {
    const doc = new Y.Doc();
    const payload = {
      documentName: projectMetaDocName(PID),
      document: doc,
      instance: { documents: new Map() },
    };

    await hook(payload);
    const firstAt = published(doc).publishedAt;
    await hook(payload);

    expect(published(doc).publishedAt).toBe(firstAt);
    doc.destroy();
  });
});

describe("别的文档加载时", () => {
  it("画布文档不被写进 schema —— 那是 meta 的事", async () => {
    const hook = await loadHook();
    const doc = new Y.Doc();

    await hook({
      documentName: spaceContentDocName(PID, SID, "canvas"),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc)).toEqual({});
    doc.destroy();
  });

  it("document space 的正文文档也不被写", async () => {
    const hook = await loadHook();
    const doc = new Y.Doc();

    await hook({
      documentName: spaceContentDocName(PID, SID, "document"),
      document: doc,
      instance: { documents: new Map() },
    });

    expect(published(doc)).toEqual({});
    doc.destroy();
  });
});

describe("发布这一步自己抛了异常的时候", () => {
  it("加载不失败、错误进日志 —— 而不是把每个人挡在门外还不留痕", async () => {
    // hocuspocus 不给 `afterLoadDocument` 兜底（它只包了 `onLoadDocument`），
    // 抛出去会一路冒到建连那层，那里回客户端一句「没权限」、一行日志都不打。
    // 每个客户端第一份文档就是 meta，所以那等于「所有 project 都打不开」，
    // 而服务器上没有任何东西指向真正的原因。
    const hook = await loadHook();
    const doc = new Y.Doc();
    // 让写入那一步抛：发布现在只碰这份 Yjs 文档，没有别的外部输入了。
    vi.spyOn(doc, "transact").mockImplementation(() => {
      throw new Error("这份文档写不进去");
    });
    loggerSpy.error.mockClear();

    await expect(
      hook({
        documentName: projectMetaDocName(PID),
        document: doc,
        instance: { documents: new Map() },
      }),
    ).resolves.toBeUndefined();

    expect(loggerSpy.error).toHaveBeenCalledTimes(1);
    expect(loggerSpy.error.mock.calls[0]?.[0]).toMatchObject({
      reason: "document_schema_publish_failed",
    });
    // 发布失败 = meta 里读不出词表 = 「不拦截」，本来就是安全的那一边。
    expect(published(doc)).toEqual({});
    doc.destroy();
  });
});
